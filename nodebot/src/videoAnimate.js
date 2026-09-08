// Image-to-video, through OpenRouter's dedicated /api/v1/videos endpoint
// (a separate surface from the /chat/completions one media.js and music.js
// use — video generation is asynchronous: POST returns a job immediately,
// and the actual clip is fetched once polling shows it done).
//
// Takes a still image (whatever generateImage already produced) as the
// first frame and animates it into a few seconds of silent motion —
// generate_audio: false, since the caller always mixes in its own
// narration or song audio afterward (see videomaker.js's assembleVideo).
// frame_images accepts the image as a data: URI directly, so there is no
// need to host the still anywhere first.
import { OPENROUTER_API_KEY, PUBLIC_URL } from './config.js';

export class VideoAnimateError extends Error {}

const VIDEOS_URL = 'https://openrouter.ai/api/v1/videos';
const POLL_INTERVAL_MS = 3000;
// A ceiling on total wait per clip, not a per-request timeout — video jobs
// queue behind other work on the provider's side, and a clip that isn't
// back in a few minutes is treated as failed rather than hung forever.
const MAX_POLL_MS = 5 * 60 * 1000;

function headers() {
  if (!OPENROUTER_API_KEY) throw new VideoAnimateError('OPENROUTER_API_KEY is not set');
  return {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': PUBLIC_URL || 'https://github.com/seed0001/discord-agent',
    'X-Title': 'Discord Agent',
  };
}

function errorMessage(body, fallback) {
  if (!body) return fallback;
  if (typeof body.error === 'string') return body.error;
  if (body.error?.message) return body.error.message;
  return fallback;
}

/**
 * Animate a still image into a short, silent video clip.
 *
 * @param {Buffer} imageData
 * @param {string} imageMediaType e.g. 'image/png', 'image/jpeg'
 * @param {object} [opts]
 * @param {string} opts.model OpenRouter video model slug (required — callers
 *   resolve the per-guild/env default before calling in)
 * @param {number} [opts.durationSec] clip length in seconds; each model
 *   clamps to its own supported range, so this is a request, not a guarantee
 * @param {typeof fetch} [opts.fetchFn] test-only override
 * @param {(ms: number) => Promise<void>} [opts.sleepFn] test-only override —
 *   real call sites never pass either of these (same seam shape as
 *   music.js/videomaker.js's fetchFn/runFfmpegFn)
 * @returns {Promise<{data: Buffer, mediaType: string, costUsd: number}>}
 */
export async function animateImage(imageData, imageMediaType, {
  model, durationSec = 8, fetchFn = fetch, sleepFn = (ms) => new Promise((r) => { setTimeout(r, ms); }),
} = {}) {
  if (!imageData?.length) throw new VideoAnimateError('an image is required to animate');
  if (!model) throw new VideoAnimateError('a video animation model is required');

  const dataUrl = `data:${imageMediaType || 'image/png'};base64,${imageData.toString('base64')}`;
  const submitResp = await fetchFn(VIDEOS_URL, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model,
      duration: durationSec,
      generate_audio: false,
      frame_images: [{ type: 'image_url', image_url: { url: dataUrl }, frame_type: 'first_frame' }],
    }),
  });
  const submitText = await submitResp.text();
  let job = null;
  try { job = JSON.parse(submitText); } catch { /* non-JSON body */ }
  if (!submitResp.ok || job?.error) {
    throw new VideoAnimateError(
      `video animation request failed (${submitResp.status}): ${errorMessage(job, submitText.slice(0, 300) || `HTTP ${submitResp.status}`)}`,
    );
  }
  if (!job?.id) throw new VideoAnimateError('video animation job was accepted but returned no job id');

  const pollUrl = job.polling_url || `${VIDEOS_URL}/${job.id}`;
  const deadline = Date.now() + MAX_POLL_MS;
  while (job.status === 'pending' || job.status === 'in_progress') {
    if (Date.now() > deadline) throw new VideoAnimateError('video animation timed out waiting for the clip to render');
    // eslint-disable-next-line no-await-in-loop
    await sleepFn(POLL_INTERVAL_MS);
    // eslint-disable-next-line no-await-in-loop
    const pollResp = await fetchFn(pollUrl, { headers: headers() });
    // eslint-disable-next-line no-await-in-loop
    const pollText = await pollResp.text();
    try { job = JSON.parse(pollText); } catch {
      throw new VideoAnimateError('video animation status check returned malformed JSON');
    }
    if (!pollResp.ok) {
      throw new VideoAnimateError(`video animation status check failed (${pollResp.status}): ${errorMessage(job, pollText.slice(0, 300))}`);
    }
  }
  if (job.status !== 'completed') {
    throw new VideoAnimateError(`video animation failed: ${errorMessage(job, `ended in unexpected status "${job.status}"`)}`);
  }
  const url = job.unsigned_urls?.[0];
  if (!url) throw new VideoAnimateError('video animation completed but returned no video url');

  const fileResp = await fetchFn(url, { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` } });
  if (!fileResp.ok) throw new VideoAnimateError(`downloading the animated clip failed (${fileResp.status})`);
  const data = Buffer.from(await fileResp.arrayBuffer());
  return { data, mediaType: 'video/mp4', costUsd: job.usage?.cost || 0 };
}
