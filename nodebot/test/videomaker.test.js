// videomaker.js — the native video pipeline. Script generation goes through
// the global fetch (faked here, same seam media.test.js uses), but images,
// narration, and ffmpeg are exercised through their injectable overrides
// (deps.generateImageFn / synthesizeFn / runFfmpegFn) instead: media.js's
// generateImage is already covered in media.test.js, tts.synthesize hits a
// real external library (msedge-tts) that isn't fetch-based and bills real
// guilds via credits.meter, and there's no ffmpeg binary to assume present
// in every environment this runs in. Real call sites never pass any of
// these overrides — same "test seam, production never touches it" shape as
// isOwner's ownerId or media.js's `now`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createVideo, createMusicVideo, extractJson, extensionFor, VideoMakerError } from '../src/videomaker.js';

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

const SCENES = (n) => Array.from({ length: n }, (_, i) => ({
  narration: `narration ${i + 1}`, image_prompt: `a picture for scene ${i + 1}`,
}));

function scriptResponse({ scenes = SCENES(2), cost = 0.01, title = 'A Test Video' } = {}) {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify({
      title, description: 'a description', tags: ['a', 'b'], scenes,
    }) } }],
    usage: { cost },
  });
}

function fakeFetch(body = scriptResponse()) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    return body;
  };
  return { fn, calls };
}

function fakeImages({ cost = 0.02 } = {}) {
  const calls = [];
  const fn = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return { images: [{ data: Buffer.from(`img:${prompt}`), mediaType: 'image/jpeg' }], costUsd: cost };
  };
  return { fn, calls };
}

function fakeNarration() {
  const calls = [];
  const fn = async (text, opts) => {
    calls.push({ text, opts });
    return Buffer.from(`aud:${text}`);
  };
  return { fn, calls };
}

/** Records the ffmpeg args and, since the pipeline reads the real output
 * file back off disk afterward, actually writes something to the output
 * path (always the last arg) so that read succeeds without a real binary. */
function fakeFfmpeg() {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    await writeFile(args[args.length - 1], Buffer.from('FAKE_MP4'));
  };
  return { fn, calls };
}

/** Stands in for videoAnimate.animateImage: turns a still into a fake "clip"
 * buffer so assembleVideo's ffmpeg call can be inspected without a real
 * OpenRouter video job or a real ffmpeg binary. */
function fakeAnimate({ cost = 0.5 } = {}) {
  const calls = [];
  const fn = async (data, mediaType, opts) => {
    calls.push({ data, mediaType, opts });
    return { data: Buffer.from(`clip:${data.toString()}`), mediaType: 'video/mp4', costUsd: cost };
  };
  return { fn, calls };
}

function baseDeps(overrides = {}) {
  const fetch_ = overrides.fetch ?? fakeFetch();
  const images = overrides.images ?? fakeImages();
  const narration = overrides.narration ?? fakeNarration();
  const ffmpeg = overrides.ffmpeg ?? fakeFfmpeg();
  const animate = overrides.animate ?? fakeAnimate();
  return {
    deps: {
      fetchFn: fetch_.fn,
      generateImageFn: images.fn,
      synthesizeFn: narration.fn,
      runFfmpegFn: ffmpeg.fn,
      animateFn: animate.fn,
    },
    calls: {
      fetch: fetch_.calls, images: images.calls, narration: narration.calls, ffmpeg: ffmpeg.calls, animate: animate.calls,
    },
  };
}

// ===========================================================================
// extractJson
// ===========================================================================

test('extractJson parses a bare JSON object', () => {
  assert.deepEqual(extractJson('{"a": 1}'), { a: 1 });
});

test('extractJson strips a markdown fence', () => {
  assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
});

test('extractJson takes the outermost braces when there is prose around it', () => {
  assert.deepEqual(extractJson('Sure, here you go:\n{"a": 1}\nHope that helps!'), { a: 1 });
});

test('extractJson throws a VideoMakerError when there is no JSON object at all', () => {
  assert.throws(() => extractJson('no json here'), VideoMakerError);
});

test('extractJson throws a VideoMakerError on malformed JSON', () => {
  assert.throws(() => extractJson('{"a": }'), VideoMakerError);
});

// ===========================================================================
// extensionFor
// ===========================================================================

test('extensionFor maps common types, including the jpeg special case', () => {
  assert.equal(extensionFor('image/jpeg'), 'jpg');
  assert.equal(extensionFor('image/png'), 'png');
  assert.equal(extensionFor('image/webp'), 'webp');
  assert.equal(extensionFor(undefined), 'png');
  assert.equal(extensionFor('image/png; charset=binary'), 'png');
});

// ===========================================================================
// createVideo
// ===========================================================================

test('a blank topic is rejected before any request goes out', async () => {
  const { deps, calls } = baseDeps();
  await assert.rejects(createVideo('   ', { deps }), VideoMakerError);
  await assert.rejects(createVideo('', { deps }), /topic is required/);
  assert.equal(calls.fetch.length, 0, 'a blank topic must not cost a request');
});

test('the full pipeline runs script -> images -> narration -> assemble and returns a real mp4 buffer', async () => {
  const { deps, calls } = baseDeps();
  const clip = await createVideo('the history of cats', { deps });

  assert.ok(Buffer.isBuffer(clip.data));
  assert.equal(clip.data.toString(), 'FAKE_MP4');
  assert.equal(clip.contentType, 'video/mp4');
  assert.equal(clip.title, 'A Test Video');
  assert.equal(clip.sceneCount, 2);

  assert.equal(calls.fetch.length, 1, 'one script request');
  assert.equal(calls.fetch[0].body.messages[1].content, 'Topic: the history of cats');
  assert.equal(calls.images.length, 2, 'one image request per scene');
  assert.equal(calls.narration.length, 2, 'one narration request per scene');
  // one ffmpeg call per scene segment, plus one for the final concat
  assert.equal(calls.ffmpeg.length, 3);
});

test('notes are appended to the script request when given, omitted when not', async () => {
  const { deps, calls } = baseDeps();
  await createVideo('cats', { deps, notes: 'keep it lighthearted' });
  assert.match(calls.fetch[0].body.messages[1].content, /Extra guidance: keep it lighthearted/);

  const second = baseDeps();
  await createVideo('cats', { deps: second.deps });
  assert.doesNotMatch(second.calls.fetch[0].body.messages[1].content, /Extra guidance/);
});

test('imageModel and scriptModel overrides are forwarded to the respective calls', async () => {
  const { deps, calls } = baseDeps();
  await createVideo('cats', { deps, imageModel: 'some/image-model', scriptModel: 'some/script-model' });
  assert.equal(calls.fetch[0].body.model, 'some/script-model');
  assert.ok(calls.images.every((c) => c.opts.model === 'some/image-model'));
});

test('total cost sums the script cost and every scene image cost', async () => {
  const { deps } = baseDeps({
    fetch: fakeFetch(scriptResponse({ scenes: SCENES(3), cost: 0.05 })),
    images: fakeImages({ cost: 0.02 }),
  });
  const clip = await createVideo('cats', { deps });
  // 0.05 script + 3 scenes * 0.02 each, floating point tolerance
  assert.ok(Math.abs(clip.costUsd - 0.11) < 1e-9, `expected ~0.11, got ${clip.costUsd}`);
});

test('scene order survives out-of-order concurrent completion', async () => {
  const scenes = SCENES(4);
  const images = { calls: [] };
  images.fn = async (prompt, opts) => {
    images.calls.push({ prompt, opts });
    // later scenes resolve first
    const n = Number(prompt.match(/scene (\d+)/)[1]);
    await new Promise((r) => setTimeout(r, (5 - n) * 5));
    return { images: [{ data: Buffer.from(`img-${n}`), mediaType: 'image/png' }], costUsd: 0 };
  };
  const ffmpeg = fakeFfmpeg();
  const { deps } = baseDeps({
    fetch: fakeFetch(scriptResponse({ scenes })), images, ffmpeg,
  });
  await createVideo('cats', { deps });
  // segment N's input image path should reference scene_N — i.e. the Nth
  // ffmpeg segment call used the Nth scene's image, not whichever finished first
  const segmentCalls = ffmpeg.calls.slice(0, 4);
  segmentCalls.forEach((args, i) => {
    const imgPath = args[args.indexOf('-i') + 1];
    assert.match(imgPath, new RegExp(`scene_${i + 1}\\.`));
  });
});

test('a non-OK script response surfaces the upstream error message', async () => {
  const { deps } = baseDeps({
    fetch: fakeFetch(jsonResponse({ error: { message: 'model not found' } }, 404)),
  });
  await assert.rejects(
    createVideo('cats', { deps }),
    (err) => err instanceof VideoMakerError && /404/.test(err.message) && /model not found/.test(err.message),
  );
});

test('a script with zero scenes is rejected', async () => {
  const { deps } = baseDeps({ fetch: fakeFetch(scriptResponse({ scenes: [] })) });
  await assert.rejects(createVideo('cats', { deps }), /zero scenes/);
});

test('a scene missing narration or an image prompt is rejected', async () => {
  const { deps } = baseDeps({
    fetch: fakeFetch(scriptResponse({ scenes: [{ narration: 'only narration' }] })),
  });
  await assert.rejects(createVideo('cats', { deps }), /scene 1/);
});

test('a scene whose narration has no TTS backend fails the whole job', async () => {
  const narration = { calls: [], fn: async () => null };
  const { deps } = baseDeps({ narration });
  await assert.rejects(createVideo('cats', { deps }), /no TTS backend produced audio/);
});

test('an image generation failure propagates rather than being swallowed', async () => {
  const images = { calls: [], fn: async () => { throw new Error('OpenRouter is down'); } };
  const { deps } = baseDeps({ images });
  await assert.rejects(createVideo('cats', { deps }), /OpenRouter is down/);
});

test('an ffmpeg failure propagates as a VideoMakerError', async () => {
  const ffmpeg = { calls: [], fn: async () => { throw new VideoMakerError('ffmpeg failed: boom'); } };
  const { deps } = baseDeps({ ffmpeg });
  await assert.rejects(createVideo('cats', { deps }), /ffmpeg failed/);
});

test('onStatus reports each stage in order, ending near 100% before the final read', async () => {
  const { deps } = baseDeps({ fetch: fakeFetch(scriptResponse({ scenes: SCENES(2) })) });
  const stages = [];
  await createVideo('cats', { deps, onStatus: async (info) => stages.push({ ...info }) });
  const seen = [...new Set(stages.map((s) => s.stage))];
  assert.deepEqual(seen, ['script', 'images', 'narration', 'assemble']);
  assert.ok(stages.every((s) => s.progress >= 0 && s.progress <= 1));
  // progress is monotonically non-decreasing across the whole run
  for (let i = 1; i < stages.length; i += 1) {
    assert.ok(stages[i].progress >= stages[i - 1].progress, `progress went backwards at index ${i}`);
  }
  assert.equal(stages.at(-1).stage, 'assemble');
  assert.ok(stages.at(-1).stageProgress >= 0.99);
});

// -- animate: still scenes -> silent moving clips ----------------------------

test('animate defaults to false: scenes stay static and animateFn is never called', async () => {
  const { deps, calls } = baseDeps();
  await createVideo('cats', { deps });
  assert.equal(calls.animate.length, 0);
  // every per-scene ffmpeg call loops a still, none loop a video clip
  const perSceneCalls = calls.ffmpeg.slice(0, -1); // last call is the final concat
  assert.ok(perSceneCalls.every((args) => args.includes('-loop') && !args.includes('-stream_loop')));
});

test('animate:true animates every scene and loops the clip instead of a still', async () => {
  const { deps, calls } = baseDeps({ fetch: fakeFetch(scriptResponse({ scenes: SCENES(3) })) });
  const clip = await createVideo('cats', { deps, animate: true, animationModel: 'kwaivgi/kling-v3.0-std' });

  assert.equal(calls.animate.length, 3, 'one animation call per scene');
  assert.ok(calls.animate.every((c) => c.opts.model === 'kwaivgi/kling-v3.0-std'));

  const perSceneCalls = calls.ffmpeg.slice(0, -1);
  assert.equal(perSceneCalls.length, 3);
  assert.ok(perSceneCalls.every((args) => args.includes('-stream_loop') && !args.includes('-loop')));

  // 0.01 script + 3 * 0.02 images + 3 * 0.5 animate (fakeAnimate's default cost)
  assert.ok(Math.abs(clip.costUsd - (0.01 + 0.06 + 1.5)) < 1e-9, `unexpected total cost ${clip.costUsd}`);
});

test('onStatus includes the animate stage only when animate is on', async () => {
  const { deps } = baseDeps();
  const stages = [];
  await createVideo('cats', { deps, animate: true, onStatus: async (info) => stages.push({ ...info }) });
  const seen = [...new Set(stages.map((s) => s.stage))];
  assert.deepEqual(seen, ['script', 'images', 'animate', 'narration', 'assemble']);
  assert.ok(stages.every((s) => s.progress >= 0 && s.progress <= 1));
  for (let i = 1; i < stages.length; i += 1) {
    assert.ok(stages[i].progress >= stages[i - 1].progress, `progress went backwards at index ${i}`);
  }
});

// ===========================================================================
// createMusicVideo
// ===========================================================================
//
// Same script -> images -> assemble shape as createVideo, but there's no
// narration/TTS step: the script only writes image_prompts (from the song's
// own generation prompt, which is where its lyrics live), and the "per-scene
// audio" assembleVideo consumes comes from slicing the song itself into
// equal-length pieces (probeDurationFn stands in for ffprobe, same "test seam,
// production never touches it" shape as runFfmpegFn).

const MV_SCENES = (n) => Array.from({ length: n }, (_, i) => ({ image_prompt: `a picture for scene ${i + 1}` }));

function musicScriptResponse({ scenes = MV_SCENES(3), cost = 0.01, title = 'A Music Video' } = {}) {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify({
      title, description: 'a description', tags: ['a', 'b'], scenes,
    }) } }],
    usage: { cost },
  });
}

function fakeProbe(duration = 30) {
  const calls = [];
  const fn = async (filePath) => { calls.push(filePath); return duration; };
  return { fn, calls };
}

function testSong(overrides = {}) {
  return {
    title: 'Test Song',
    prompt: 'a chill lofi beat, lyrics: rain on the window, quiet nights, waiting for the morning light',
    data: Buffer.from('SONGBYTES'),
    mediaType: 'audio/mpeg',
    ...overrides,
  };
}

function baseMusicVideoDeps(overrides = {}) {
  const fetch_ = overrides.fetch ?? fakeFetch(musicScriptResponse());
  const images = overrides.images ?? fakeImages();
  const ffmpeg = overrides.ffmpeg ?? fakeFfmpeg();
  const probe = overrides.probe ?? fakeProbe();
  const animate = overrides.animate ?? fakeAnimate();
  return {
    deps: {
      fetchFn: fetch_.fn,
      generateImageFn: images.fn,
      runFfmpegFn: ffmpeg.fn,
      probeDurationFn: probe.fn,
      animateFn: animate.fn,
    },
    calls: {
      fetch: fetch_.calls, images: images.calls, ffmpeg: ffmpeg.calls, probe: probe.calls, animate: animate.calls,
    },
  };
}

test('a song with no audio is rejected before any request goes out', async () => {
  const { deps, calls } = baseMusicVideoDeps();
  await assert.rejects(createMusicVideo({}, { deps }), /generated song is required/);
  assert.equal(calls.fetch.length, 0, 'a missing song must not cost a request');
});

test('a song with no generation prompt is rejected — that is what carries the lyrics', async () => {
  const { deps, calls } = baseMusicVideoDeps();
  await assert.rejects(
    createMusicVideo(testSong({ prompt: '' }), { deps }),
    /generation prompt is required/,
  );
  assert.equal(calls.fetch.length, 0);
});

test('the full pipeline runs script -> images -> slice -> assemble and returns a real mp4 buffer', async () => {
  const { deps, calls } = baseMusicVideoDeps();
  const clip = await createMusicVideo(testSong(), { deps });

  assert.ok(Buffer.isBuffer(clip.data));
  assert.equal(clip.data.toString(), 'FAKE_MP4');
  assert.equal(clip.contentType, 'video/mp4');
  assert.equal(clip.title, 'A Music Video');
  assert.equal(clip.sceneCount, 3);

  assert.equal(calls.fetch.length, 1, 'one script request');
  assert.match(calls.fetch[0].body.messages[1].content, /Test Song/);
  assert.match(calls.fetch[0].body.messages[1].content, /rain on the window/);
  assert.equal(calls.images.length, 3, 'one image request per scene');
  assert.equal(calls.probe.length, 1, 'the song is probed for duration once, not per scene');
  // one ffmpeg slice per scene, one per-scene encode per scene, plus one final concat
  assert.equal(calls.ffmpeg.length, 3 + 3 + 1);
});

test('notes are appended to the script request when given, omitted when not', async () => {
  const { deps, calls } = baseMusicVideoDeps();
  await createMusicVideo(testSong(), { deps, notes: 'make it moody' });
  assert.match(calls.fetch[0].body.messages[1].content, /Extra guidance: make it moody/);

  const second = baseMusicVideoDeps();
  await createMusicVideo(testSong(), { deps: second.deps });
  assert.doesNotMatch(second.calls.fetch[0].body.messages[1].content, /Extra guidance/);
});

test('imageModel and scriptModel overrides are forwarded to the respective calls', async () => {
  const { deps, calls } = baseMusicVideoDeps();
  await createMusicVideo(testSong(), { deps, imageModel: 'some/image-model', scriptModel: 'some/script-model' });
  assert.equal(calls.fetch[0].body.model, 'some/script-model');
  assert.ok(calls.images.every((c) => c.opts.model === 'some/image-model'));
});

test('the song is sliced into as many equal-length pieces as there are scenes', async () => {
  const { deps, calls } = baseMusicVideoDeps({
    fetch: fakeFetch(musicScriptResponse({ scenes: MV_SCENES(5) })),
    probe: fakeProbe(50),
  });
  await createMusicVideo(testSong(), { deps });
  // 5 slice cuts + 5 per-scene encodes + 1 final concat
  assert.equal(calls.ffmpeg.length, 5 + 5 + 1);
  const sliceCalls = calls.ffmpeg.filter((args) => args.includes('-ss'));
  assert.equal(sliceCalls.length, 5);
  // 50s / 5 scenes = 10s each; the first four are exactly segDuration, the
  // last one takes whatever remains so float rounding never clips the tail
  const starts = sliceCalls.map((args) => Number(args[args.indexOf('-ss') + 1]));
  assert.deepEqual(starts, [0, 10, 20, 30, 40]);
});

test('a non-OK script response surfaces the upstream error message', async () => {
  const { deps } = baseMusicVideoDeps({
    fetch: fakeFetch(jsonResponse({ error: { message: 'model not found' } }, 404)),
  });
  await assert.rejects(
    createMusicVideo(testSong(), { deps }),
    (err) => err instanceof VideoMakerError && /404/.test(err.message) && /model not found/.test(err.message),
  );
});

test('a script with zero scenes is rejected', async () => {
  const { deps } = baseMusicVideoDeps({ fetch: fakeFetch(musicScriptResponse({ scenes: [] })) });
  await assert.rejects(createMusicVideo(testSong(), { deps }), /zero scenes/);
});

test('a scene missing an image prompt is rejected', async () => {
  const { deps } = baseMusicVideoDeps({
    fetch: fakeFetch(musicScriptResponse({ scenes: [{}] })),
  });
  await assert.rejects(createMusicVideo(testSong(), { deps }), /scene 1/);
});

test('a slicing failure propagates as a VideoMakerError', async () => {
  const probe = { calls: [], fn: async () => { throw new VideoMakerError('ffprobe failed: boom'); } };
  const { deps } = baseMusicVideoDeps({ probe });
  await assert.rejects(createMusicVideo(testSong(), { deps }), /ffprobe failed/);
});

test('onStatus reports script/images/slicing/assemble in order, ending near 100%', async () => {
  const { deps } = baseMusicVideoDeps();
  const stages = [];
  await createMusicVideo(testSong(), { deps, onStatus: async (info) => stages.push({ ...info }) });
  const seen = [...new Set(stages.map((s) => s.stage))];
  assert.deepEqual(seen, ['script', 'images', 'slicing', 'assemble']);
  assert.ok(stages.every((s) => s.progress >= 0 && s.progress <= 1));
  for (let i = 1; i < stages.length; i += 1) {
    assert.ok(stages[i].progress >= stages[i - 1].progress, `progress went backwards at index ${i}`);
  }
  assert.equal(stages.at(-1).stage, 'assemble');
  assert.ok(stages.at(-1).stageProgress >= 0.99);
});

// -- animate: still scenes -> silent moving clips ----------------------------

test('animate defaults to false: scenes stay static and animateFn is never called', async () => {
  const { deps, calls } = baseMusicVideoDeps();
  await createMusicVideo(testSong(), { deps });
  assert.equal(calls.animate.length, 0);
  const perSceneCalls = calls.ffmpeg.filter((args) => !args.includes('-ss')).slice(0, -1);
  assert.ok(perSceneCalls.every((args) => args.includes('-loop') && !args.includes('-stream_loop')));
});

test('animate:true animates every scene and loops the clip instead of a still', async () => {
  const { deps, calls } = baseMusicVideoDeps({ fetch: fakeFetch(musicScriptResponse({ scenes: MV_SCENES(3) })) });
  await createMusicVideo(testSong(), { deps, animate: true, animationModel: 'kwaivgi/kling-v3.0-std' });

  assert.equal(calls.animate.length, 3, 'one animation call per scene');
  assert.ok(calls.animate.every((c) => c.opts.model === 'kwaivgi/kling-v3.0-std'));

  // slice cuts (have -ss) are unaffected; the per-scene encodes (no -ss,
  // excluding the final concat) should now loop a video clip
  const sliceCalls = calls.ffmpeg.filter((args) => args.includes('-ss'));
  const perSceneCalls = calls.ffmpeg.filter((args) => !args.includes('-ss')).slice(0, -1);
  assert.equal(sliceCalls.length, 3);
  assert.equal(perSceneCalls.length, 3);
  assert.ok(perSceneCalls.every((args) => args.includes('-stream_loop') && !args.includes('-loop')));
});

test('onStatus includes the animate stage only when animate is on, for music videos too', async () => {
  const { deps } = baseMusicVideoDeps();
  const stages = [];
  await createMusicVideo(testSong(), { deps, animate: true, onStatus: async (info) => stages.push({ ...info }) });
  const seen = [...new Set(stages.map((s) => s.stage))];
  assert.deepEqual(seen, ['script', 'images', 'animate', 'slicing', 'assemble']);
  assert.ok(stages.every((s) => s.progress >= 0 && s.progress <= 1));
  for (let i = 1; i < stages.length; i += 1) {
    assert.ok(stages[i].progress >= stages[i - 1].progress, `progress went backwards at index ${i}`);
  }
});
