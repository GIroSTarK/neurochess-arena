import { createServer, type Socket } from "node:net";

export async function createSmtpMailbox(reject = false) {
  const messages: string[] = [];
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    socket.write("220 localhost test SMTP\r\n");
    let buffer = "";
    let data: string[] | undefined;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line !== ".") data.push(line);
          else {
            messages.push(data.join("\r\n"));
            data = undefined;
            socket.write("250 queued\r\n");
          }
        } else if (/^DATA$/i.test(line)) {
          data = [];
          socket.write("354 end with dot\r\n");
        } else if (/^RCPT TO:/i.test(line) && reject) {
          socket.write("550 rejected smtp-secret-canary\r\n");
        } else if (/^STARTTLS$/i.test(line)) socket.write("454 TLS unavailable\r\n");
        else if (/^QUIT$/i.test(line)) socket.end("221 bye\r\n");
        else socket.write("250 localhost\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No SMTP test port");
  return {
    port: address.port,
    messages,
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
