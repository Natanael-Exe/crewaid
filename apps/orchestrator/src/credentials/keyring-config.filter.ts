import { Catch, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { SERVER_MISCONFIGURED_CODE } from '@crewaid/shared';
import { KeyringConfigError } from './keyring.js';

/**
 * Turn a misconfigured credential keyring into an answer, not a 500.
 *
 * Why this exists
 *
 * `CredentialService` reads `CREWAID_CREDENTIAL_KEYRING` lazily, on purpose: an
 * orchestrator with no keyring can still serve chat, sandboxes and the very
 * settings pages an operator would use to fix it, so throwing at boot would
 * take all of that down to report one variable.
 *
 * The cost of that choice is that the failure has to arrive as a request
 * failure, and it arrived as a bare 500. `parseKeyring` produces a precise
 * sentence — which variable, and what shape it wants — and every word of it
 * was thrown away: the operator got "Something went wrong. Try again." on the
 * one screen where trying again cannot possibly work. That is the shape of the
 * problem, not a missing log line, because the operator is not reading the
 * server's log.
 *
 * What it is safe to say
 *
 * `KeyringConfigError`'s messages are written to name the VARIABLE and its
 * expected shape and never to quote its value — deliberately, because a parse
 * error that echoes the input puts every key in the ring into the report. That
 * property is what makes forwarding the message to a client safe, so this
 * filter forwards it verbatim rather than paraphrasing it into something
 * vaguer and less useful.
 *
 * 503 rather than 500: the request was well-formed and the server is the thing
 * that is not ready. It is the same status the capacity refusal uses, which is
 * why both carry a `code` — the client reads that, never the prose.
 */
@Catch(KeyringConfigError)
export class KeyringConfigFilter implements ExceptionFilter<KeyringConfigError> {
  catch(exception: KeyringConfigError, host: ArgumentsHost): void {
    // Structurally typed, the way MulterErrorFilter does it: the orchestrator
    // does not depend on express's types, and this needs two methods.
    const response = host
      .switchToHttp()
      .getResponse<{ status: (code: number) => { json: (body: unknown) => void } }>();
    response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: SERVER_MISCONFIGURED_CODE,
      message: exception.message,
    });
  }
}
