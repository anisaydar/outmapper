import { loadServerConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadServerConfig();
const server = await buildServer(config);
let closing = false;

const shutdown = async () => {
  if (closing) return;
  closing = true;
  await server.close();
};

const requestShutdown = () => {
  void shutdown().catch((error) => {
    server.log.error(error);
    process.exitCode = 1;
  });
};

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

try {
  await server.listen({ host: config.host, port: config.port });
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
}
