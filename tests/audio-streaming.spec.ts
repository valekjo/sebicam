import { test, expect, type Page } from '@playwright/test';

test.use({
  launchOptions: {
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
  serviceWorkers: 'block',
  permissions: ['microphone', 'camera'],
});

test.setTimeout(60_000);

test('audio flows from broadcaster to viewer and shows on spectrogram', async ({ context }) => {
    const broadcaster = await context.newPage();
    const viewer = await context.newPage();

    // Block html5-qrcode (scanner) on both pages — we mock it.
    // Keep qrcode.min.js (QR generator) — it sets container.title with the payload.
    for (const page of [broadcaster, viewer]) {
      await page.route('**/lib/html5-qrcode.min.js', (route) =>
        route.fulfill({ body: '', contentType: 'application/javascript' }),
      );
    }

    // --- Broadcaster mocks ---
    await broadcaster.addInitScript(() => {
      // Mock Html5Qrcode scanner
      (window as any).Html5Qrcode = class {
        constructor(_elementId: string) {}
        start(
          _cameraConfig: unknown,
          _scanSettings: unknown,
          successCb: (text: string) => void,
        ) {
          (window as any).__qrInject = (text: string) => successCb(text);
          return Promise.resolve();
        }
        stop() {
          return Promise.resolve();
        }
      };

      // Mock getUserMedia → 1000 Hz oscillator
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        osc.frequency.value = 1000;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        (window as any).__testAudioCtx = ctx;
        (window as any).__testOscillator = osc;
        (window as any).__testDest = dest;
        return dest.stream;
      };
    });

    // --- Viewer mocks ---
    await viewer.addInitScript(() => {
      (window as any).Html5Qrcode = class {
        constructor(_elementId: string) {}
        start(
          _cameraConfig: unknown,
          _scanSettings: unknown,
          successCb: (text: string) => void,
        ) {
          (window as any).__qrInject = (text: string) => successCb(text);
          return Promise.resolve();
        }
        stop() {
          return Promise.resolve();
        }
      };
    });

    // Navigate both pages
    await broadcaster.goto('/broadcaster.html');
    await viewer.goto('/viewer.html');

    // --- Phase 1: Broadcaster creates offer QR ---
    await broadcaster.click('#btn-start');

    await broadcaster.waitForFunction(
      () => document.getElementById('qr-container')?.title?.startsWith('SBC1:'),
      { timeout: 15_000 },
    );
    const offerText = await broadcaster.evaluate(
      () => document.getElementById('qr-container')!.title,
    );
    console.log('Offer payload:', offerText.length, 'chars');

    // --- Phase 2: Viewer receives offer, generates answer QR ---
    await viewer.waitForFunction(
      () => typeof (window as any).__qrInject === 'function',
      { timeout: 5_000 },
    );
    await viewer.evaluate((text) => (window as any).__qrInject(text), offerText);

    await viewer.waitForFunction(
      () => document.getElementById('answer-qr-container')?.title?.startsWith('SBC1:'),
      { timeout: 15_000 },
    );
    const answerText = await viewer.evaluate(
      () => document.getElementById('answer-qr-container')!.title,
    );
    console.log('Answer payload:', answerText.length, 'chars');

    // --- Phase 3: Broadcaster scans viewer's answer QR ---
    await broadcaster.click('#btn-scan-response');
    await broadcaster.waitForFunction(
      () => typeof (window as any).__qrInject === 'function',
      { timeout: 5_000 },
    );
    await broadcaster.evaluate((text) => (window as any).__qrInject(text), answerText);

    // --- Phase 4: Wait for both sides to report "Connected" ---
    await Promise.all([
      broadcaster.waitForFunction(
        () => document.getElementById('text-connection')?.textContent === 'Connected',
        { timeout: 15_000 },
      ),
      viewer.waitForFunction(
        () => document.getElementById('text-connection')?.textContent === 'Connected',
        { timeout: 15_000 },
      ),
    ]);
    console.log('Both pages connected');

    // Wait for viewer to receive audio and start playing
    await viewer.waitForFunction(
      () => {
        const audio = document.getElementById('remote-audio') as HTMLAudioElement;
        return audio?.srcObject != null && !audio.paused;
      },
      { timeout: 15_000 },
    );
    console.log('Viewer audio playing');

    // Let spectrogram accumulate data
    await viewer.waitForTimeout(3_000);

    // --- Phase 5: Verify single tone (1000 Hz) ---
    await viewer.locator('#spectrogram').screenshot({
      path: 'test-results/spectrogram-1000hz.png',
    });

    const singleTone = await analyzeSpectrogram(viewer);
    const single1kHz = maxInRange(singleTone, 220, 245);
    const single4kHz = maxInRange(singleTone, 155, 185);
    console.log('Single-tone: 1kHz max =', single1kHz, ', 4kHz max =', single4kHz);

    expect(single1kHz, 'Expected bright 1000 Hz band').toBeGreaterThan(50);
    expect(single4kHz, 'Expected dark 4000 Hz region for single tone').toBeLessThan(50);

    // --- Phase 6: Add a second oscillator at 4000 Hz ---
    await broadcaster.evaluate(() => {
      const ctx = (window as any).__testAudioCtx as AudioContext;
      const dest = (window as any).__testDest as MediaStreamAudioDestinationNode;
      const osc2 = ctx.createOscillator();
      osc2.frequency.value = 4000;
      osc2.connect(dest);
      osc2.start();
      (window as any).__testOscillator2 = osc2;
    });

    // Wait for the new frequency to appear in the spectrogram
    await viewer.waitForTimeout(3_000);

    // --- Phase 7: Verify dual tone (1000 Hz + 4000 Hz) ---
    await viewer.locator('#spectrogram').screenshot({
      path: 'test-results/spectrogram-dual-tone.png',
    });

    const dualTone = await analyzeSpectrogram(viewer);
    const dual1kHz = maxInRange(dualTone, 220, 245);
    const dual4kHz = maxInRange(dualTone, 155, 185);
    console.log('Dual-tone: 1kHz max =', dual1kHz, ', 4kHz max =', dual4kHz);

    expect(dual1kHz, 'Expected bright 1000 Hz band').toBeGreaterThan(50);
    expect(dual4kHz, 'Expected bright 4000 Hz band after adding oscillator').toBeGreaterThan(50);
});

/** Read the rightmost 30 columns of the spectrogram canvas → per-row luminance array. */
async function analyzeSpectrogram(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const canvas = document.getElementById('spectrogram') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const colWidth = 30;
    const imageData = ctx.getImageData(
      canvas.width - colWidth,
      0,
      colWidth,
      canvas.height,
    );
    const rowLuminance: number[] = [];
    for (let row = 0; row < canvas.height; row++) {
      let sum = 0;
      for (let col = 0; col < colWidth; col++) {
        const idx = (row * colWidth + col) * 4;
        sum +=
          (imageData.data[idx] + imageData.data[idx + 1] + imageData.data[idx + 2]) / 3;
      }
      rowLuminance.push(sum / colWidth);
    }
    return rowLuminance;
  });
}

/** Maximum luminance in a row range (inclusive). */
function maxInRange(luminance: number[], startRow: number, endRow: number): number {
  let max = 0;
  for (let i = startRow; i <= endRow && i < luminance.length; i++) {
    if (luminance[i] > max) max = luminance[i];
  }
  return max;
}
