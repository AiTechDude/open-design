import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateMedia } from '../src/media.js';

// 1x1 PNG used as the image-to-video source frame.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2uoAAAAASUVORK5CYII=',
  'base64',
);
const TEST_HIGGSFIELD_BASE_URL = 'https://higgsfield-gateway.example.test';

describe('higgsfield video generation', () => {
  let root: string;
  let projectRoot: string;
  let projectsRoot: string;
  const realFetch = globalThis.fetch;
  const originalMediaConfigDir = process.env.OD_MEDIA_CONFIG_DIR;
  const originalDataDir = process.env.OD_DATA_DIR;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'od-higgsfield-'));
    projectRoot = path.join(root, 'project-root');
    projectsRoot = path.join(projectRoot, '.od', 'projects');
    await mkdir(projectsRoot, { recursive: true });
    delete process.env.OD_MEDIA_CONFIG_DIR;
    delete process.env.OD_DATA_DIR;
    process.env.OD_HIGGSFIELD_API_KEY = 'key-id:key-secret';
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    delete process.env.OD_HIGGSFIELD_API_KEY;
    if (originalMediaConfigDir == null) {
      delete process.env.OD_MEDIA_CONFIG_DIR;
    } else {
      process.env.OD_MEDIA_CONFIG_DIR = originalMediaConfigDir;
    }
    if (originalDataDir == null) {
      delete process.env.OD_DATA_DIR;
    } else {
      process.env.OD_DATA_DIR = originalDataDir;
    }
    await rm(root, { recursive: true, force: true });
  });

  async function writeConfig(data: unknown) {
    const file = path.join(projectRoot, '.od', 'media-config.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data), 'utf8');
  }

  async function seedSourceImage(): Promise<string> {
    const dir = path.join(projectsRoot, 'project-1');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'seed.png'), PNG_BYTES);
    return 'seed.png';
  }

  it('renders DoP image-to-video via submit + poll + download', async () => {
    await writeConfig({
      providers: {
        higgsfield: { baseUrl: TEST_HIGGSFIELD_BASE_URL },
      },
    });
    const image = await seedSourceImage();

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === `${TEST_HIGGSFIELD_BASE_URL}/higgsfield-ai/dop/standard`) {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({
          authorization: 'Key key-id:key-secret',
          'content-type': 'application/json',
        });
        const body = JSON.parse(String(init?.body));
        expect(body.prompt).toBe('Slow dolly-in on the product');
        expect(body.duration).toBe(5);
        expect(String(body.image_url)).toMatch(/^data:image\/png;base64,/);
        return new Response(JSON.stringify({
          status: 'queued',
          request_id: 'req-1',
          status_url: `${TEST_HIGGSFIELD_BASE_URL}/requests/req-1/status`,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === `${TEST_HIGGSFIELD_BASE_URL}/requests/req-1/status`) {
        expect(init?.headers).toMatchObject({ authorization: 'Key key-id:key-secret' });
        return new Response(JSON.stringify({
          status: 'completed',
          request_id: 'req-1',
          video: { url: `${TEST_HIGGSFIELD_BASE_URL}/out/req-1.mp4` },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === `${TEST_HIGGSFIELD_BASE_URL}/out/req-1.mp4`) {
        return new Response(Buffer.from('fake-mp4-bytes'), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'video',
      model: 'higgsfield-dop-standard',
      prompt: 'Slow dolly-in on the product',
      length: 5,
      image,
      output: 'hero.mp4',
    });

    expect(result.name).toBe('hero.mp4');
    expect(result.providerId).toBe('higgsfield');
    expect(result.providerNote).toContain('higgsfield/higgsfield-dop-standard');
    expect(result.providerNote).toContain('i2v');

    const bytes = await readFile(path.join(projectsRoot, 'project-1', 'hero.mp4'));
    expect(bytes.toString()).toBe('fake-mp4-bytes');
  });

  it('rejects a text-to-video request (DoP needs a source image)', async () => {
    await expect(generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'video',
      model: 'higgsfield-dop-standard',
      prompt: 'A spaceship over a city',
      length: 5,
    })).rejects.toThrow(/image-to-video/);
  });

  it('surfaces an upstream submit error', async () => {
    const image = await seedSourceImage();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'invalid credentials' },
    }), { status: 401, headers: { 'content-type': 'application/json' } })));

    await expect(generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'video',
      model: 'higgsfield-dop-standard',
      prompt: 'A neon skyline pan',
      length: 5,
      image,
    })).rejects.toThrow(/higgsfield video submit 401/);
  });
});
