import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Set by the auth pre-handlers once a request is authenticated. Carries the
     * resolved account so downstream code can pick the per-user proxy and log
     * usage. `proxyUrl` is the customer's stored proxy (decrypted) — never log it.
     */
    auth?: {
      userId: string | null;
      apiKeyId: string | null;
      proxyUrl: string | null;
      isAdmin: boolean;
    };
  }
}
