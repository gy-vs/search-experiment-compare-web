import type { IncomingMessage } from 'node:http';
import request from 'supertest';
import type { Application } from 'express';
import type { ExperimentEventData } from '../src/shared/types';

export interface SseFrame {
  id: number | null;
  event: string;
  data: ExperimentEventData;
}

const decoder = new TextDecoder();

/**
 * Consume an SSE response as raw chunks and parse incrementally — using
 * res.json/buffer would wait for the stream to end, hiding streaming order.
 */
export function openEvents(
  app: Application,
  id: string,
  query: Record<string, string> = {},
): {
  frames: SseFrame[];
  done: Promise<void>;
  buffer: string;
  rawChunks: string[];
} {
  const frames: SseFrame[] = [];
  const rawChunks: string[] = [];
  let buffer = '';
  let resolve: () => void;
  const done = new Promise<void>((r) => (resolve = r));

  request(app)
    .get(`/api/experiments/${id}/events`)
    .query(query)
    .buffer(true)
    .parse(((res: IncomingMessage, callback: (err: Error | null, body: unknown) => void) => {
      res.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        rawChunks.push(text);
        buffer += text;
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (block.startsWith(':')) continue; // comment / heartbeat
          let id: number | null = null;
          let event = 'message';
          const dataLines: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('id:')) id = Number(line.slice(3).trim());
            else if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          frames.push({ id, event, data: JSON.parse(dataLines.join('\n')) });
        }
      });
      res.on('end', () => {
        callback(null, rawChunks.join(''));
        resolve();
      });
      res.on('error', (error) => callback(error, null));
    }) as never)
    .end(() => {});

  return { frames, done, get buffer() { return buffer; }, rawChunks };
}

export async function waitFor(
  frames: SseFrame[],
  predicate: (frames: SseFrame[]) => boolean,
  timeoutMs = 2000,
): Promise<SseFrame[]> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate(frames)) return frames;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `timed out waiting for SSE condition. frames: ${frames.map((f) => `${f.id}:${f.event}`).join(',')}`,
  );
}

export function waitEvent(frames: SseFrame[], type: string, timeoutMs = 2000) {
  return waitFor(frames, (all) => all.some((frame) => frame.event === type), timeoutMs);
}

export function queryResults(frames: SseFrame[]) {
  return frames
    .filter((frame) => frame.event === 'query_result')
    .map((frame) => frame.data as Extract<ExperimentEventData, { type: 'query_result' }>);
}
