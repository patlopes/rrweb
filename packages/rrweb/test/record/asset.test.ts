import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import type { recordOptions } from '../../src/types';
import type { listenerHandler, eventWithTime, assetEvent } from '@rrweb/types';
import { EventType } from '@rrweb/types';
import {
  getServerURL,
  launchPuppeteer,
  startServer,
  waitForRAF,
} from '../utils';
import type * as http from 'http';

interface ISuite {
  code: string;
  browser: puppeteer.Browser;
  page: puppeteer.Page;
  events: eventWithTime[];
  server: http.Server;
  serverURL: string;
  serverB: http.Server;
  serverBURL: string;
}

interface IWindow extends Window {
  rrweb: {
    record: (
      options: recordOptions<eventWithTime>,
    ) => listenerHandler | undefined;
    addCustomEvent<T>(tag: string, payload: T): void;
    pack: (e: eventWithTime) => string;
  };
  emit: (e: eventWithTime) => undefined;
  snapshots: eventWithTime[];
}
type ExtraOptions = {
  assetCaptureConfig?: recordOptions<eventWithTime>['assetCaptureConfig'];
};

const BASE64_PNG_RECTANGLE =
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAAXNSR0IArs4c6QAAAWtJREFUeF7t1cEJAEAIxEDtv2gProo8xgpCwuLezI3LGFhBMi0+iCCtHoLEeggiSM1AjMcPESRmIIZjIYLEDMRwLESQmIEYjoUIEjMQw7EQQWIGYjgWIkjMQAzHQgSJGYjhWIggMQMxHAsRJGYghmMhgsQMxHAsRJCYgRiOhQgSMxDDsRBBYgZiOBYiSMxADMdCBIkZiOFYiCAxAzEcCxEkZiCGYyGCxAzEcCxEkJiBGI6FCBIzEMOxEEFiBmI4FiJIzEAMx0IEiRmI4ViIIDEDMRwLESRmIIZjIYLEDMRwLESQmIEYjoUIEjMQw7EQQWIGYjgWIkjMQAzHQgSJGYjhWIggMQMxHAsRJGYghmMhgsQMxHAsRJCYgRiOhQgSMxDDsRBBYgZiOBYiSMxADMdCBIkZiOFYiCAxAzEcCxEkZiCGYyGCxAzEcCxEkJiBGI6FCBIzEMOxEEFiBmI4FiJIzEAMx0IEiRmI4TwVjsedWCiXGAAAAABJRU5ErkJggg==';

async function injectRecordScript(
  frame: puppeteer.Frame,
  options?: ExtraOptions,
) {
  await frame.addScriptTag({
    path: path.resolve(__dirname, '../../dist/rrweb-all.js'),
  });
  options = options || {};
  await frame.evaluate((options) => {
    (window as unknown as IWindow).snapshots = [];
    const { record, pack } = (window as unknown as IWindow).rrweb;
    const config: recordOptions<eventWithTime> = {
      assetCaptureConfig: options.assetCaptureConfig,
      emit(event) {
        (window as unknown as IWindow).snapshots.push(event);
        (window as unknown as IWindow).emit(event);
      },
    };
    record(config);
  }, options);

  for (const child of frame.childFrames()) {
    await injectRecordScript(child, options);
  }
}

const setup = function (
  this: ISuite,
  content: string,
  options?: ExtraOptions,
): ISuite {
  const ctx = {} as ISuite;
  beforeAll(async () => {
    ctx.browser = await launchPuppeteer();
    ctx.server = await startServer();
    ctx.serverURL = getServerURL(ctx.server);
    ctx.serverB = await startServer();
    ctx.serverBURL = getServerURL(ctx.serverB);

    const bundlePath = path.resolve(__dirname, '../../dist/rrweb.js');
    ctx.code = fs.readFileSync(bundlePath, 'utf8');
  });

  beforeEach(async () => {
    ctx.page = await ctx.browser.newPage();
    await ctx.page.goto('about:blank');
    await ctx.page.setContent(
      content
        .replace(/\{SERVER_URL\}/g, ctx.serverURL)
        .replace(/\{SERVER_B_URL\}/g, ctx.serverBURL),
    );
    // await ctx.page.evaluate(ctx.code);
    await waitForRAF(ctx.page);
    await ctx.page.waitForTimeout(500); // FIXME!!
    ctx.events = [];
    await ctx.page.exposeFunction('emit', (e: eventWithTime) => {
      if (e.type === EventType.DomContentLoaded || e.type === EventType.Load) {
        return;
      }
      ctx.events.push(e);
    });

    ctx.page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
    if (
      options?.assetCaptureConfig?.captureOrigins &&
      Array.isArray(options.assetCaptureConfig.captureOrigins)
    ) {
      options.assetCaptureConfig.captureOrigins =
        options.assetCaptureConfig.captureOrigins.map((origin) =>
          origin.replace(/\{SERVER_URL\}/g, ctx.serverURL),
        );
    }
    await injectRecordScript(ctx.page.mainFrame(), options);
  });

  afterEach(async () => {
    await ctx.page.close();
  });

  afterAll(async () => {
    await ctx.browser.close();
    ctx.server.close();
    ctx.serverB.close();
  });

  return ctx;
};

describe('asset caching', function (this: ISuite) {
  jest.setTimeout(100_000);

  describe('captureObjectURLs: true with incremental snapshots', function (this: ISuite) {
    const ctx: ISuite = setup.call(
      this,
      `
        <!DOCTYPE html>
        <html>
          <body></body>
        </html>
      `,
      {
        assetCaptureConfig: {
          captureObjectURLs: true,
          captureOrigins: false,
        },
      },
    );

    it('will emit asset when included as img attribute mutation', async () => {
      const url = (await ctx.page.evaluate(() => {
        return new Promise((resolve) => {
          // create a blob of an image, then create an object URL for the blob
          // and append it to the DOM as `src` attribute of an existing image
          const img = document.createElement('img');
          document.body.appendChild(img);

          const canvas = document.createElement('canvas');
          canvas.width = 100;
          canvas.height = 100;
          const context = canvas.getContext('2d')!;
          context.fillStyle = 'red';
          context.fillRect(0, 0, 100, 100);

          canvas.toBlob((blob) => {
            if (!blob) return;

            const url = URL.createObjectURL(blob);
            img.src = url;
            resolve(url);
          });
        });
      })) as string;
      await waitForRAF(ctx.page);
      // await ctx.page.waitForTimeout(40_000);
      const events = await ctx.page?.evaluate(
        () => (window as unknown as IWindow).snapshots,
      );
      const expected: assetEvent = {
        type: EventType.Asset,
        data: {
          url,
          payload: {
            rr_type: 'Blob',
            data: [
              {
                rr_type: 'ArrayBuffer',
                base64: BASE64_PNG_RECTANGLE, // base64
              },
            ],
          },
        },
      };
      console.log(events);
      expect(events[events.length - 1]).toMatchObject(expected);
    });

    it('will emit asset when included with new img', async () => {
      const url = (await ctx.page.evaluate(() => {
        return new Promise((resolve) => {
          // create a blob of an image, then create an object URL for the blob and append it to the DOM as image `src` attribute
          const canvas = document.createElement('canvas');
          canvas.width = 100;
          canvas.height = 100;
          const context = canvas.getContext('2d')!;
          context.fillStyle = 'red';
          context.fillRect(0, 0, 100, 100);

          canvas.toBlob((blob) => {
            if (!blob) return;

            const url = URL.createObjectURL(blob);
            const img = document.createElement('img');
            img.src = url;
            document.body.appendChild(img);
            resolve(url);
          });
        });
      })) as string;
      await waitForRAF(ctx.page);
      // await ctx.page.waitForTimeout(40_000);
      const events = await ctx.page?.evaluate(
        () => (window as unknown as IWindow).snapshots,
      );
      const expected: assetEvent = {
        type: EventType.Asset,
        data: {
          url,
          payload: {
            rr_type: 'Blob',
            data: [
              {
                rr_type: 'ArrayBuffer',
                base64: BASE64_PNG_RECTANGLE, // base64
              },
            ],
          },
        },
      };
      console.log(events);
      expect(events[events.length - 1]).toMatchObject(expected);
    });
  });

  describe('captureObjectURLs: true with fullSnapshot', function (this: ISuite) {
    const ctx: ISuite = setup.call(
      this,
      `
        <!DOCTYPE html>
        <html>
          <body>
          <script>
            const b64toBlob = (b64Data, contentType='', sliceSize=512) => {
              const byteCharacters = atob(b64Data);
              const byteArrays = [];

              for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
                const slice = byteCharacters.slice(offset, offset + sliceSize);

                const byteNumbers = new Array(slice.length);
                for (let i = 0; i < slice.length; i++) {
                  byteNumbers[i] = slice.charCodeAt(i);
                }

                const byteArray = new Uint8Array(byteNumbers);
                byteArrays.push(byteArray);
              }

              const blob = new Blob(byteArrays, {type: contentType});
              return blob;
            }

            const base64 = "${BASE64_PNG_RECTANGLE}";
            const contentType = 'image/png';
            const blob = b64toBlob(base64, contentType);
            const url = URL.createObjectURL(blob);
            const img = document.createElement('img');
            img.src = url;
            document.body.appendChild(img);
          </script>
          </body>
        </html>
      `,
      {
        assetCaptureConfig: {
          captureObjectURLs: true,
          captureOrigins: false,
        },
      },
    );

    it('will emit asset when included with existing img', async () => {
      await waitForRAF(ctx.page);
      const url = (await ctx.page.evaluate(() => {
        return document.querySelector('img')?.src;
      })) as string;
      await waitForRAF(ctx.page);

      const events = await ctx.page?.evaluate(
        () => (window as unknown as IWindow).snapshots,
      );
      const expected: assetEvent = {
        type: EventType.Asset,
        data: {
          url,
          payload: {
            rr_type: 'Blob',
            data: [
              {
                rr_type: 'ArrayBuffer',
                base64: BASE64_PNG_RECTANGLE, // base64
              },
            ],
          },
        },
      };
      expect(events[events.length - 1]).toMatchObject(expected);
    });
  });
  describe('captureObjectURLs: false', () => {
    const ctx: ISuite = setup.call(
      this,
      `
        <!DOCTYPE html>
        <html>
          <body></body>
        </html>
      `,
      {
        assetCaptureConfig: {
          captureObjectURLs: false,
          captureOrigins: false,
        },
      },
    );
    it("shouldn't capture ObjectURLs when its turned off in config", async () => {
      const url = (await ctx.page.evaluate(() => {
        return new Promise((resolve) => {
          // create a blob of an image, then create an object URL for the blob and append it to the DOM as image `src` attribute
          const canvas = document.createElement('canvas');
          canvas.width = 100;
          canvas.height = 100;
          const context = canvas.getContext('2d')!;
          context.fillStyle = 'red';
          context.fillRect(0, 0, 100, 100);

          canvas.toBlob((blob) => {
            if (!blob) return;

            const url = URL.createObjectURL(blob);
            const img = document.createElement('img');
            img.src = url;
            document.body.appendChild(img);
            resolve(url);
          });
        });
      })) as string;
      await waitForRAF(ctx.page);
      // await ctx.page.waitForTimeout(40_000);
      const events = await ctx.page?.evaluate(
        () => (window as unknown as IWindow).snapshots,
      );

      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: EventType.Asset,
        }),
      );
    });
  });
  describe('data urls', () => {
    const ctx: ISuite = setup.call(
      this,
      `
        <!DOCTYPE html>
        <html>
          <body>
          <img src="data:image/png;${BASE64_PNG_RECTANGLE}" />
          </body>
        </html>
      `,
    );

    it("shouldn't re-capture data:urls", async () => {
      const events = await ctx.page?.evaluate(
        () => (window as unknown as IWindow).snapshots,
      );

      // expect no event to be emitted with `event.type` === EventType.Asset
      console.log(events);
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: EventType.Asset,
        }),
      );
    });
  });
  describe('captureOrigins: false', () => {
    const ctx: ISuite = setup.call(
      this,
      `
        <!DOCTYPE html>
        <html>
          <body>
            <img src="{SERVER_URL}/html/assets/robot.png" />
          </body>
        </html>
      `,
      {
        assetCaptureConfig: {
          captureOrigins: false,
          captureObjectURLs: false,
        },
      },
    );

    it("shouldn't capture any urls", async () => {
      const events = await ctx.page?.evaluate(
        () => (window as unknown as IWindow).snapshots,
      );

      // expect no event to be emitted with `event.type` === EventType.Asset
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: EventType.Asset,
        }),
      );
    });
  });
  describe('captureOrigins: []', () => {
    const ctx: ISuite = setup.call(
      this,
      `
        <!DOCTYPE html>
        <html>
          <body>
            <img src="{SERVER_URL}/html/assets/robot.png" />
          </body>
        </html>
      `,
      {
        assetCaptureConfig: {
          captureOrigins: [],
          captureObjectURLs: false,
        },
      },
    );

    it("shouldn't capture any urls", async () => {
      const events = await ctx.page?.evaluate(
        () => (window as unknown as IWindow).snapshots,
      );

      // expect no event to be emitted with `event.type` === EventType.Asset
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: EventType.Asset,
        }),
      );
    });
  });
  describe('captureOrigins: true', () => {
    const ctx: ISuite = setup.call(
      this,
      `
        <!DOCTYPE html>
        <html>
          <body>
            <img src="{SERVER_URL}/html/assets/robot.png" />
          </body>
        </html>
      `,
      {
        assetCaptureConfig: {
          captureOrigins: true,
          captureObjectURLs: false,
        },
      },
    );

    it('capture all urls', async () => {
      await ctx.page.waitForNetworkIdle({ idleTime: 100 });
      await waitForRAF(ctx.page);

      const events = await ctx.page?.evaluate(
        () => (window as unknown as IWindow).snapshots,
      );

      // expect an event to be emitted with `event.type` === EventType.Asset
      expect(events).toContainEqual(
        expect.objectContaining({
          type: EventType.Asset,
        }),
      );
    });
  });
  describe('captureOrigins: ["http://localhost:xxxxx/"]', () => {
    const ctx: ISuite = setup.call(
      this,
      `
        <!DOCTYPE html>
        <html>
          <body>
            <img src="{SERVER_URL}/html/assets/robot.png" />
            <img src="{SERVER_B_URL}/html/assets/robot.png" />
          </body>
        </html>
      `,
      {
        assetCaptureConfig: {
          captureOrigins: ['{SERVER_URL}'],
          captureObjectURLs: false,
        },
      },
    );

    it('should capture assets with origin defined in config', async () => {
      await ctx.page.waitForNetworkIdle({ idleTime: 100 });
      await waitForRAF(ctx.page);

      const events = await ctx.page?.evaluate(
        () => (window as unknown as IWindow).snapshots,
      );

      // expect an event to be emitted with `event.type` === EventType.Asset
      expect(events).toContainEqual(
        expect.objectContaining({
          type: EventType.Asset,
          data: {
            url: `${ctx.serverURL}/html/assets/robot.png`,
            payload: expect.any(Object),
          },
        }),
      );
    });
    it("shouldn't capture assets with origin not defined in config", async () => {
      await ctx.page.waitForNetworkIdle({ idleTime: 100 });
      await waitForRAF(ctx.page);

      const events = await ctx.page?.evaluate(
        () => (window as unknown as IWindow).snapshots,
      );

      // expect an event to be emitted with `event.type` === EventType.Asset
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: EventType.Asset,
          data: {
            url: `${ctx.serverBURL}/html/assets/robot.png`,
            payload: expect.any(Object),
          },
        }),
      );
    });
  });
});