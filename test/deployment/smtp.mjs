// Isolated TLS SMTP fixture, mounted only by the deployment rehearsal.
import { readFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:tls";

let message = "";
createServer(
  {
    cert: readFileSync("/fixture/postgres-cert.pem"),
    key: readFileSync("/fixture/postgres-key.pem"),
  },
  (socket) => {
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    socket.write("220 mail rehearsal\r\n");
    let buffer = "";
    let data;
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line !== ".") data.push(line);
          else {
            message = data.join("\r\n");
            data = undefined;
            socket.write("250 queued\r\n");
          }
        } else if (line === "DATA") {
          data = [];
          socket.write("354 send data\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 mail\r\n");
      }
    });
  },
).listen(1025, "0.0.0.0");
httpServer((_request, response) => response.end(message)).listen(1026, "0.0.0.0");
