import type { FastifyReply, FastifyRequest } from "fastify";

function configuredApiKey(): string | null {
  return process.env.API_KEY?.trim() || null;
}

function requireApiKey(): boolean {
  return process.env.REQUIRE_API_KEY === "true" || Boolean(configuredApiKey());
}

export async function requireApiKeyAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireApiKey()) return;

  const expected = configuredApiKey();
  if (!expected) {
    await reply.status(500).send({ success: false, error: { code: "AUTH_NOT_CONFIGURED", message: "API key auth is required but API_KEY is not configured." } });
    return;
  }

  const authorization = request.headers.authorization;
  const bearer = authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : null;
  const header = request.headers["x-api-key"];
  const apiKey = bearer ?? (Array.isArray(header) ? header[0] : header);

  if (apiKey !== expected) {
    await reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED", message: "Missing or invalid API key." } });
  }
}
