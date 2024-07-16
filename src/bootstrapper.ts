import http from "http";

const server = http.createServer((req, res) => {
	if (req.method === "POST" && req.url === "/") {
		let body = "";
		req.on("data", chunk => {
			body += chunk.toString();
		});
		req.on("end", () => {
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/plain");
			res.end("Received POST request with body: " + body);
		});
	} else {
		res.statusCode = 404;
		res.end("Only POST at / is supported");
	}
});

const port = process.env.PORT || 9870;
server.listen(port, () => {
	console.log(`Server listening on port ${port}`);
});
