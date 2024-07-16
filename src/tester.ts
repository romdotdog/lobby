import type * as node from "./node.js";

let t = 0;
async function createNode(name: string): Promise<typeof node> {
	const n = await import("./node.js?t=" + t++);
	n.setDebugName(name);
	return n;
}

const bootstrapper = await createNode("bootstrapper");

async function bootstrap(n: typeof node, b: typeof node = bootstrapper) {
	const [offerSDP, answer] = await n.instantiate();
	const answerSDP = await b.instantiate(offerSDP);
	answer(answerSDP);
}

const baseNodes = [];
for (let i = 0; i < 10; i++) {
	const child = await createNode(i.toString());
	await bootstrap(child);
	baseNodes.push(child);
}

const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;

const a = await createNode("A");
a.setMode(keyPair);
const b = await createNode("B");
b.setMode(keyPair);

bootstrap(a, baseNodes[(Math.random() * baseNodes.length) | 0]);
bootstrap(b, baseNodes[(Math.random() * baseNodes.length) | 0]);
