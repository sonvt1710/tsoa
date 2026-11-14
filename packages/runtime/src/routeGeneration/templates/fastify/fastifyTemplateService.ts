import type { FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'stream';
import type { File } from '../../../interfaces/file';

import { Controller } from '../../../interfaces/controller';
import { FieldErrors } from '../../templateHelpers';
import { TsoaRoute } from '../../tsoa-route';
import { ValidateError } from '../../templateHelpers';
import { TemplateService } from '../templateService';

type FastifyApiHandlerParameters = {
  methodName: string;
  controller: Controller | object;
  request: FastifyRequest;
  reply: FastifyReply;
  validatedArgs: any[];
  successStatus?: number;
};

type FastifyValidationArgsParameters = {
  args: Record<string, TsoaRoute.ParameterSchema>;
  request: FastifyRequest;
  reply: FastifyReply;
};

type MemoryFile = Pick<File, 'fieldname' | 'originalname' | 'encoding' | 'mimetype' | 'size' | 'buffer'>;

type MultipartPart =
  | { type: 'file'; fieldname: string; filename: string; encoding: string; mimetype: string; file: { truncated: boolean }; toBuffer(): Promise<Buffer> }
  | { type: 'field'; fieldname: string; value: unknown; valueTruncated: boolean; fieldnameTruncated: boolean };

type MultipartRequest = FastifyRequest & {
  isMultipart(): boolean;
  parts(): AsyncIterable<MultipartPart>;
  server: { multipartErrors: { RequestFileTooLargeError: new () => Error } };
};

type FastifyReturnHandlerParameters = {
  request: FastifyRequest;
  reply: FastifyReply;
  headers: any;
  statusCode?: number;
  data?: any;
};

export class FastifyTemplateService extends TemplateService<FastifyApiHandlerParameters, FastifyValidationArgsParameters, FastifyReturnHandlerParameters> {
  private readonly files = new WeakMap<FastifyRequest, Record<string, MemoryFile[]>>();
  private readonly replies = new WeakMap<FastifyReply, { started: boolean }>();

  initializeReply(reply: FastifyReply): void {
    if (this.replies.has(reply)) return;
    const state = { started: false };
    this.replies.set(reply, state);
    const send = reply.send.bind(reply);
    reply.send = payload => {
      // Fastify can send again during error recovery; observe rather than suppress those calls.
      const result = send(payload);
      state.started = true;
      return result;
    };
  }

  hasResponseStarted(reply: FastifyReply): boolean {
    return reply.sent || this.replies.get(reply)?.started === true;
  }

  /**
   * Turns the failure that authentication reports into the error Fastify hands to the error handler.
   * An Error keeps its identity, so `instanceof` checks and its stack still work. Any other value is
   * wrapped in an Error whose `cause` is that value. Both carry `statusCode` for Fastify's default handler.
   */
  authenticationError(failure: { message?: unknown; status?: number }): Error & { status: number; statusCode: number } {
    const status = failure.status || 401;
    // failureToReport hands back the rejection itself, or an object inheriting from it when the rejection is frozen.
    if (failure instanceof Error) {
      return Object.assign(failure, { status, statusCode: status });
    }
    const cause = failure instanceof String ? failure.valueOf() : failure;
    const error = new Error(typeof failure.message === 'string' ? failure.message : '');
    return Object.assign(error, { cause, status, statusCode: status });
  }

  private responseCompletion(reply: FastifyReply): Promise<void> {
    const completion = new Promise<void>((resolve, reject) => reply.then(resolve, reject));
    void completion.catch(() => undefined);
    return completion;
  }

  async apiHandler(params: FastifyApiHandlerParameters) {
    const { methodName, controller, request, reply, validatedArgs, successStatus } = params;
    this.initializeReply(reply);
    if (this.hasResponseStarted(reply)) return this.responseCompletion(reply);

    let data;
    try {
      data = await this.buildPromise(methodName, controller, validatedArgs);
    } catch (error) {
      if (!this.hasResponseStarted(reply)) throw error;
      reply.log.error({ err: error }, 'Controller failed after sending a response');
      return this.responseCompletion(reply);
    }
    if (this.hasResponseStarted(reply)) return this.responseCompletion(reply);
    let statusCode = successStatus;
    let headers;
    if (this.isController(controller)) {
      headers = controller.getHeaders();
      statusCode = controller.getStatus() || statusCode;
    }
    return this.returnHandler({ request, reply, headers, statusCode, data });
  }

  getValidatedArgs(params: FastifyValidationArgsParameters): any[] {
    const { args, request, reply } = params;
    this.initializeReply(reply);

    const errorFields: FieldErrors = {};
    const values = this.getParameters(args).map(param => {
      const name = param.name;
      switch (param.in) {
        case 'request':
          return request;
        case 'request-prop': {
          const descriptor = Object.getOwnPropertyDescriptor(request, name);
          const value = descriptor ? descriptor.value : undefined;
          return this.validationService.ValidateParam(param, value, name, errorFields, false, undefined);
        }
        case 'query':
          return this.validationService.ValidateParam(param, (request.query as Record<string, unknown>)[name], name, errorFields, false, undefined);
        case 'queries':
          return this.validationService.ValidateParam(param, request.query, name, errorFields, false, undefined);
        case 'path':
          return this.validationService.ValidateParam(param, (request.params as Record<string, unknown>)[name], name, errorFields, false, undefined);
        case 'header':
          return this.validationService.ValidateParam(param, request.headers[name], name, errorFields, false, undefined);
        case 'body': {
          if (param.dataType === 'binary') {
            if (request.body === undefined) return Readable.from([]);
            if (request.body instanceof Readable && !request.body.readableEnded) return request.body;
            errorFields[name] = { message: 'request body was already consumed by a body parser' };
            return undefined;
          }
          const descriptor = Object.getOwnPropertyDescriptor(request, 'body');
          const value = descriptor ? descriptor.value : undefined;
          const bodyFieldErrors: FieldErrors = {};
          const result = this.validationService.ValidateParam(param, value, name, bodyFieldErrors, true, undefined);
          Object.keys(bodyFieldErrors).forEach(key => {
            errorFields[key] = { message: bodyFieldErrors[key].message };
          });
          return result;
        }
        case 'body-prop': {
          const descriptor = Object.getOwnPropertyDescriptor(request, 'body');
          const value = descriptor?.value?.[name];
          const bodyFieldErrors: FieldErrors = {};
          const result = this.validationService.ValidateParam(param, value, name, bodyFieldErrors, true, 'body.');
          Object.keys(bodyFieldErrors).forEach(key => {
            errorFields[key] = { message: bodyFieldErrors[key].message };
          });
          return result;
        }
        case 'formData': {
          const body = request.body as Record<string, unknown> | undefined;
          if (param.dataType === 'file' || (param.dataType === 'array' && param.array && param.array.dataType === 'file')) {
            const fileArgs = this.validationService.ValidateParam(param, this.files.get(request)?.[name], name, errorFields, false, undefined);
            if (param.dataType === 'array') {
              return fileArgs;
            }
            return Array.isArray(fileArgs) && fileArgs.length === 1 ? fileArgs[0] : fileArgs;
          }
          return this.validationService.ValidateParam(param, body?.[name], name, errorFields, false, undefined);
        }
        case 'res':
          return (status: number | undefined, data: any, headers: any): Promise<void> => this.returnHandler({ request, reply, headers, statusCode: status, data });
      }
    });
    if (this.hasFieldErrors(errorFields)) {
      throw new ValidateError(errorFields, JSON.stringify({ fields: errorFields }));
    }
    return values;
  }

  async collectMultipart(request: MultipartRequest, fields: ReadonlyArray<{ name: string; maxCount?: number }>): Promise<void> {
    if (!request.isMultipart()) return;
    const files: Record<string, MemoryFile[]> = Object.create(null);
    const body: Record<string, unknown> = Object.create(null);
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const field = fields.find(field => field.name === part.fieldname);
        if (!field || (field.maxCount && files[part.fieldname]?.length >= field.maxCount)) {
          throw new Error('Unexpected field');
        }
        const buffer = await part.toBuffer();
        // With throwFileSizeLimit: false the plugin hands back a silently truncated buffer.
        if (part.file.truncated) throw new request.server.multipartErrors.RequestFileTooLargeError();
        (files[part.fieldname] ||= []).push({
          fieldname: part.fieldname,
          originalname: part.filename,
          encoding: part.encoding,
          mimetype: part.mimetype,
          size: buffer.length,
          buffer,
        });
      } else {
        if (part.valueTruncated || part.fieldnameTruncated) throw new Error('Field value too long');
        const previous = body[part.fieldname];
        body[part.fieldname] = previous === undefined ? part.value : [...(Array.isArray(previous) ? previous : [previous]), part.value];
      }
    }
    request.body = body;
    this.files.set(request, files);
  }

  protected returnHandler(params: FastifyReturnHandlerParameters) {
    const { reply, statusCode, data, headers } = params;
    if (this.hasResponseStarted(reply)) return this.responseCompletion(reply);
    reply.code(statusCode || (data !== null && data !== undefined ? 200 : 204));
    reply.headers(headers || {});
    const emptyResponse = reply.statusCode === 204 || reply.statusCode === 205 || reply.statusCode === 304;
    const mediaType = String(reply.getHeader('content-type') || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    const isJson = mediaType.includes('json');
    // Like Express: no data sends an empty body, and null is sent as JSON null when the response is JSON.
    let body = emptyResponse || data === undefined || (data === null && !isJson) ? undefined : data;
    if (body === null) {
      body = 'null';
    } else if (body instanceof ArrayBuffer) {
      // Fastify sends typed arrays and Buffers as bytes, but rejects a bare ArrayBuffer.
      body = Buffer.from(body);
    } else if (body !== undefined && mediaType && !isJson && typeof body !== 'string' && !this.isRawPayload(body)) {
      body = JSON.stringify(body);
    }
    reply.send(body);
    return this.responseCompletion(reply);
  }

  /** Payloads Fastify sends as bytes: Buffers, typed arrays, ArrayBuffers, Node and web streams, and fetch Responses. */
  private isRawPayload(body: unknown): boolean {
    if (typeof body !== 'object' || body === null) return false;
    if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) return true;
    const candidate = body as { pipe?: unknown; getReader?: unknown };
    return typeof candidate.pipe === 'function' || typeof candidate.getReader === 'function' || Object.prototype.toString.call(body) === '[object Response]';
  }
}
