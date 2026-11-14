import { FastifyTemplateService } from '@tsoa/runtime/fastify';
import { TsoaResponse } from '@tsoa/runtime/index';
import { expect } from 'chai';
import Fastify, { FastifyInstance } from 'fastify';
import 'mocha';
import { Readable } from 'stream';
import { setImmediate as nextTurn } from 'timers/promises';
import { resetState, stateOf } from '../fixtures/controllers/middlewaresFastifyController';
import { RegisterRoutes } from '../fixtures/fastify/routes';

const config = { noImplicitAdditionalProperties: 'throw-on-extras', bodyCoercion: true } as const;

function respondWith(app: FastifyInstance, status: number | undefined, data: unknown, headers?: Record<string, string>) {
  const service = new FastifyTemplateService({}, config);
  class ResponseController {
    response(res: TsoaResponse<200, unknown>) {
      return (res as unknown as (s: number | undefined, d: unknown, h?: Record<string, string>) => Promise<void>)(status, data, headers);
    }
  }
  app.get('/', async (request, reply) => {
    const validatedArgs = service.getValidatedArgs({ args: { res: { in: 'res', name: 'res' } }, request, reply });
    await service.apiHandler({ methodName: 'response', controller: new ResponseController(), request, reply, validatedArgs });
    return reply;
  });
}

describe('Fastify responses and authentication', () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = Fastify();
  });
  afterEach(async () => {
    await app.close();
    resetState();
  });

  describe('binary payloads under a non-JSON content type', () => {
    const bytes = [137, 80, 78, 71];
    for (const [label, make] of [
      ['Uint8Array', () => new Uint8Array(bytes)],
      ['ArrayBuffer', () => new Uint8Array(bytes).buffer],
      ['DataView', () => new DataView(new Uint8Array(bytes).buffer)],
    ] as const) {
      it(`sends a ${label} as raw bytes`, async () => {
        respondWith(app, 200, make(), { 'Content-Type': 'image/png' });
        const response = await app.inject('/');
        expect(response.statusCode).to.equal(200);
        expect([...response.rawPayload]).to.deep.equal(bytes);
      });
    }

    it('sends a web ReadableStream as raw bytes', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
      respondWith(app, 200, stream, { 'Content-Type': 'application/octet-stream' });
      const response = await app.inject('/');
      expect([...response.rawPayload]).to.deep.equal(bytes);
    });

    it('sends a Node Readable as raw bytes', async () => {
      respondWith(app, 200, Readable.from([Buffer.from(bytes)]), { 'Content-Type': 'application/octet-stream' });
      const response = await app.inject('/');
      expect([...response.rawPayload]).to.deep.equal(bytes);
    });

    it('still serializes a plain object under a non-JSON content type', async () => {
      respondWith(app, 200, { a: 1 }, { 'Content-Type': 'text/plain' });
      const response = await app.inject('/');
      expect(response.body).to.equal('{"a":1}');
    });
  });

  describe('empty results', () => {
    for (const status of [201, 202, 404]) {
      it(`sends an empty body for undefined with status ${status}`, async () => {
        respondWith(app, status, undefined);
        const response = await app.inject('/');
        expect(response.statusCode).to.equal(status);
        expect(response.body).to.equal('');
      });
    }

    it('answers 204 with an empty body when there is no status and no data', async () => {
      respondWith(app, undefined, undefined);
      const response = await app.inject('/');
      expect(response.statusCode).to.equal(204);
      expect(response.body).to.equal('');
    });

    it('sends JSON null for null under a JSON content type', async () => {
      respondWith(app, 200, null, { 'Content-Type': 'application/json' });
      const response = await app.inject('/');
      expect(response.statusCode).to.equal(200);
      expect(response.body).to.equal('null');
      expect(response.json()).to.equal(null);
    });

    it('sends an empty body for null without a content type', async () => {
      respondWith(app, 200, null);
      const response = await app.inject('/');
      expect(response.statusCode).to.equal(200);
      expect(response.body).to.equal('');
    });
  });

  describe('authentication failures', () => {
    it('hands the rejected Error itself to the error handler, with a status', async () => {
      let seen: unknown;
      app.setErrorHandler((error, _request, reply) => {
        seen = error;
        return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ name: (error as Error).name });
      });
      app.register(RegisterRoutes);
      const response = await app.inject('/v1/SecurityTest/Koa?access_token=frozen-status');
      expect(response.statusCode).to.equal(403);
      expect(seen).to.be.instanceOf(Error);
      expect((seen as Error).message).to.equal('api_key');
    });

    it('wraps a non-Error rejection in an Error with the rejection as cause', async () => {
      let seen: unknown;
      app.setErrorHandler((error, _request, reply) => {
        seen = error;
        return reply.code((error as { statusCode?: number }).statusCode ?? 500).send();
      });
      app.register(RegisterRoutes);
      const response = await app.inject('/v1/SecurityTest/Koa?access_token=bogus');
      expect(response.statusCode).to.equal(401);
      expect(seen).to.be.instanceOf(Error);
      expect((seen as Error).message).to.equal('api_key');
      expect((seen as Error & { cause?: unknown }).cause).to.deep.equal({ message: 'api_key' });
    });
  });

  // The authentication hook returns `reply`, whose then() resolves only once the response is written.
  // Fastify then sees reply.sent and skips the remaining preHandlers, even behind slow response hooks.
  describe('a response sent by authentication', () => {
    for (const hook of ['onSend', 'preSerialization'] as const) {
      it(`skips route middlewares while an asynchronous ${hook} hook is still running`, async () => {
        resetState();
        app.addHook(hook, async (_request, _reply, payload) => {
          await nextTurn();
          await nextTurn();
          return payload;
        });
        app.register(RegisterRoutes);
        const response = await app.inject('/v1/MiddlewareTestFastify/secured?access_token=ghi123456');
        expect(response.statusCode).to.equal(401);
        expect(response.body).to.equal('some custom response');
        expect(stateOf('secured')).to.equal(undefined);
        expect(stateOf('securedController')).to.equal(undefined);
      });
    }

    it('runs route middlewares after successful authentication', async () => {
      resetState();
      app.register(RegisterRoutes);
      const response = await app.inject('/v1/MiddlewareTestFastify/secured?access_token=abc123456');
      expect(response.statusCode).to.equal(200);
      expect(stateOf('secured')).to.equal(true);
      expect(stateOf('securedController')).to.equal(true);
    });
  });
});
