// videoAnimate.js — the OpenRouter /api/v1/videos client. fetchFn/sleepFn
// are faked here (same "test seam, production never touches it" shape as
// music.js's fetchFn or videomaker.js's runFfmpegFn) since the sandbox's
// egress allowlist blocks OpenRouter anyway, and a real call would mean
// actually waiting on a video job. These are about the submit/poll/download
// state machine, not the network itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { animateImage, VideoAnimateError } from '../src/videoAnimate.js';

function jsonResp(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

function fileResp(text, status = 200) {
  const bytes = new TextEncoder().encode(text);
  return { ok: status < 400, status, arrayBuffer: async () => bytes.buffer };
}

/** Returns each queued response in order, one per fetchFn call, recording
 * the url/opts of every call made along the way. */
function queueFetch(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (i >= responses.length) throw new Error(`fetch called more times (${i + 1}) than responses queued (${responses.length})`);
    const r = responses[i];
    i += 1;
    return r;
  };
  return { fn, calls };
}

function fakeSleep() {
  const calls = [];
  const fn = async (ms) => { calls.push(ms); };
  return { fn, calls };
}

const IMG = Buffer.from('PNGBYTES');

test('an empty image is rejected before any request goes out', async () => {
  const { fn: fetchFn, calls } = queueFetch([]);
  await assert.rejects(
    animateImage(Buffer.alloc(0), 'image/png', { model: 'kwaivgi/kling-v3.0-std', fetchFn }),
    /image is required/,
  );
  assert.equal(calls.length, 0);
});

test('a missing model is rejected before any request goes out', async () => {
  const { fn: fetchFn, calls } = queueFetch([]);
  await assert.rejects(animateImage(IMG, 'image/png', { fetchFn }), /model is required/);
  assert.equal(calls.length, 0);
});

test('submits a data-uri first frame with audio generation off, and returns the clip once completed', async () => {
  const { fn: fetchFn, calls } = queueFetch([
    jsonResp({ id: 'job1', status: 'completed', unsigned_urls: ['https://openrouter.ai/api/v1/videos/job1/content'], usage: { cost: 0.42 } }),
    fileResp('VIDEOBYTES'),
  ]);
  const result = await animateImage(IMG, 'image/png', { model: 'kwaivgi/kling-v3.0-std', durationSec: 6, fetchFn });

  assert.equal(result.data.toString(), 'VIDEOBYTES');
  assert.equal(result.mediaType, 'video/mp4');
  assert.equal(result.costUsd, 0.42);

  assert.equal(calls.length, 2);
  const submitBody = JSON.parse(calls[0].opts.body);
  assert.equal(submitBody.model, 'kwaivgi/kling-v3.0-std');
  assert.equal(submitBody.duration, 6);
  assert.equal(submitBody.generate_audio, false);
  assert.equal(submitBody.frame_images.length, 1);
  assert.equal(submitBody.frame_images[0].frame_type, 'first_frame');
  assert.match(submitBody.frame_images[0].image_url.url, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(submitBody.frame_images[0].image_url.url.split(',')[1], 'base64').toString(), 'PNGBYTES');
  assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/videos/job1/content');
});

test('polls the job until it completes, sleeping between checks', async () => {
  const { fn: fetchFn, calls } = queueFetch([
    jsonResp({ id: 'job2', status: 'pending', polling_url: 'https://openrouter.ai/api/v1/videos/job2' }),
    jsonResp({ id: 'job2', status: 'in_progress', polling_url: 'https://openrouter.ai/api/v1/videos/job2' }),
    jsonResp({ id: 'job2', status: 'completed', unsigned_urls: ['https://example.test/clip.mp4'] }),
    fileResp('CLIP'),
  ]);
  const { fn: sleepFn, calls: sleeps } = fakeSleep();
  const result = await animateImage(IMG, 'image/jpeg', { model: 'm', fetchFn, sleepFn });

  assert.equal(result.data.toString(), 'CLIP');
  assert.equal(sleeps.length, 2, 'one sleep per pending/in_progress poll');
  assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/videos/job2');
  assert.equal(calls[2].url, 'https://openrouter.ai/api/v1/videos/job2');
});

test('a failed job surfaces its error message', async () => {
  const { fn: fetchFn } = queueFetch([
    jsonResp({ id: 'job3', status: 'failed', error: { message: 'content policy violation' } }),
  ]);
  await assert.rejects(
    animateImage(IMG, 'image/png', { model: 'm', fetchFn }),
    (err) => err instanceof VideoAnimateError && /content policy violation/.test(err.message),
  );
});

test('a non-OK submit response surfaces the upstream error message', async () => {
  const { fn: fetchFn } = queueFetch([jsonResp({ error: { message: 'bad request' } }, 400)]);
  await assert.rejects(
    animateImage(IMG, 'image/png', { model: 'm', fetchFn }),
    (err) => err instanceof VideoAnimateError && /400/.test(err.message) && /bad request/.test(err.message),
  );
});

test('a submit response with no job id is rejected', async () => {
  const { fn: fetchFn } = queueFetch([jsonResp({ status: 'pending' })]);
  await assert.rejects(animateImage(IMG, 'image/png', { model: 'm', fetchFn }), /no job id/);
});

test('a non-OK poll response surfaces its error', async () => {
  const { fn: fetchFn } = queueFetch([
    jsonResp({ id: 'job4', status: 'pending' }),
    jsonResp({ error: { message: 'rate limited' } }, 429),
  ]);
  const { fn: sleepFn } = fakeSleep();
  await assert.rejects(
    animateImage(IMG, 'image/png', { model: 'm', fetchFn, sleepFn }),
    (err) => err instanceof VideoAnimateError && /429/.test(err.message) && /rate limited/.test(err.message),
  );
});

test('a completed job with no unsigned_urls is rejected', async () => {
  const { fn: fetchFn } = queueFetch([jsonResp({ id: 'job5', status: 'completed', unsigned_urls: [] })]);
  await assert.rejects(animateImage(IMG, 'image/png', { model: 'm', fetchFn }), /no video url/);
});

test('a download failure is reported', async () => {
  const { fn: fetchFn } = queueFetch([
    jsonResp({ id: 'job6', status: 'completed', unsigned_urls: ['https://example.test/clip.mp4'] }),
    { ok: false, status: 502 },
  ]);
  await assert.rejects(animateImage(IMG, 'image/png', { model: 'm', fetchFn }), /502/);
});
