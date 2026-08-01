import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav } from '../src/transcription.js';

test('pcmToWav produces a valid RIFF/WAVE/PCM header', () => {
  const pcm = Buffer.alloc(1920, 5); // arbitrary stereo 16-bit samples
  const wav = pcmToWav(pcm);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(wav.subarray(36, 40).toString('ascii'), 'data');
  assert.equal(wav.readUInt16LE(20), 1);      // PCM format
  assert.equal(wav.readUInt16LE(22), 2);      // channels
  assert.equal(wav.readUInt32LE(24), 48000);  // sample rate
  assert.equal(wav.readUInt16LE(34), 16);     // bits per sample
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.length, 44 + pcm.length);
});

test('pcmToWav preserves the PCM payload byte-for-byte', () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const wav = pcmToWav(pcm);
  assert.deepEqual(wav.subarray(44), pcm);
});
