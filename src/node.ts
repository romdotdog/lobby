if (typeof process !== "undefined" && process.versions && process.versions.node) {
	const wrtc = await import("@roamhq/wrtc");
	globalThis.RTCPeerConnection = wrtc.default.RTCPeerConnection;
}

//

const INFO = 0;
const ASK_TO_SOCIALIZE = 1;
const SOCIALIZE = 2;
const SOCIALIZE_BACK = 3;
const CONNECT = 4;
const ASK_AROUND = 5;
const BACKTRACK = 6;

//

function toHex(buffer: Uint8Array) {
	return Array.prototype.map.call(buffer, x => x.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string) {
	return new Uint8Array(hex.match(/.{1,2}/g)!.map(x => parseInt(x, 16)));
}

function randomInt() {
	return crypto.getRandomValues(new Uint32Array(1))[0];
}

let peerId = randomInt();
let debugName: string | undefined = undefined;
export function setDebugName(name: string) {
	debugName = name;
	console.log(`${debugName}: ${peerId}`);
}

let mode: true | CryptoKeyPair = true;
let myPublicKey: string = "";
export function setMode(m: true | CryptoKeyPair) {
	mode = m;
	if (mode !== true) {
		crypto.subtle.exportKey("raw", mode.publicKey).then(publicKeyBuffer => {
			myPublicKey = toHex(new Uint8Array(publicKeyBuffer));
		});
	}
}

async function waitForICE(conn: RTCPeerConnection) {
	if (conn.iceGatheringState === "complete") {
		return;
	}

	return new Promise<void>(resolve => {
		conn.onicecandidate = e => {
			if (e.candidate === null) {
				resolve();
			}
		};
	});
}

type AnswerFunction = (answer: string) => void;

export async function instantiate(offer: string): Promise<string>;
export async function instantiate(): Promise<[string, AnswerFunction]>;

export async function instantiate(offer?: string): Promise<string | [string, AnswerFunction]> {
	let conn = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.1.google.com:19302" }] });

	if (offer) {
		await conn.setRemoteDescription({ type: "offer", sdp: offer });
		const initialAnswer = await conn.createAnswer();
		await conn.setLocalDescription(initialAnswer);
		await waitForICE(conn);

		conn.ondatachannel = e => {
			e.channel.onopen = function () {
				greet(this);
			};
		};

		return conn.localDescription!.sdp;
	} else {
		const channel = conn.createDataChannel("main");

		channel.onopen = function () {
			greet(this);
		};

		const initialOffer = await conn.createOffer();
		await conn.setLocalDescription(initialOffer);
		await waitForICE(conn);

		// prettier-ignore
		return [conn.localDescription!.sdp, answer => {
            conn.setRemoteDescription({ type: "answer", sdp: answer });
        }];
	}
}

interface Peer {
	channel: RTCDataChannel;
	numContacts: number;
	peerId: number;
	debugName?: string;
	mode: boolean | string;
}

const peers: Peer[] = [];

function broadcast(msg: string) {
	for (let peer of peers) {
		if (peer.mode === true) peer.channel.send(msg);
	}
}

function random<T>(arr: T[]): T | undefined {
	return arr[Math.floor(Math.random() * arr.length)];
}

// peer discovery terms:
// contact - a node within a one-connection vicinity
// mutual - a node within a two-connection vicinity
// stranger - a node outside of a two-connection vicinity

// can connect with mutuals but not strangers unless using a very
// expensive algorithm

// - nodes should keep track of amount of contacts of their contacts (can be forged)

// if you gain a contact, and that contact has more connections than a mutual,
// that contact connects you with the mutual
// repeat,

let answerSocialize: AnswerFunction | undefined = undefined;
let finalConnect: AnswerFunction | undefined = undefined;

const encoder = new TextEncoder();
const seen = new Set();
const handlers: Record<number, (peer: Peer, msg: Object) => void> = {
	async [INFO](peer, msg) {
		if ("num" in msg && typeof msg.num === "number") {
			peer.numContacts = msg.num;
			if (mode === true && peer.numContacts > 1 && answerSocialize === undefined) {
				answerSocialize = () => {
					throw new Error(`${debugName} not finished offering`);
				};
				let offer;
				[offer, answerSocialize] = await instantiate();
				peer.channel.send(JSON.stringify({ type: ASK_TO_SOCIALIZE, offer }));
			}
		}
		if ("name" in msg && typeof msg.name === "string") {
			peer.debugName = msg.name;
			console.log(`${debugName} -> ${peer.debugName}`);
		}
		if ("id" in msg && typeof msg.id === "number") {
			if (peers.find(p => p.peerId === msg.id)) {
				peer.channel.close();
				return;
			}
			peer.peerId = msg.id;
		}
		if ("mode" in msg && (msg.mode === true || typeof msg.mode === "string")) {
			peer.mode = msg.mode;
		}
	},
	[ASK_TO_SOCIALIZE](peer, msg) {
		if (!("offer" in msg && typeof msg.offer === "string" && isFinite(peer.peerId))) throw new Error();
		const others = peers.filter(p => p !== peer && peer.mode === true);
		const antisocialLevel = others.reduce((n, p) => Math.min(n, p.numContacts), Infinity);
		const antisocialPeers = others.filter(p => p.numContacts === antisocialLevel);
		if (antisocialPeers.length === 0) return;
		random(antisocialPeers)!.channel.send(JSON.stringify({ type: SOCIALIZE, offer: msg.offer, peerId: peer.peerId }));
	},
	async [SOCIALIZE](peer, msg) {
		if (
			!(
				mode === true &&
				"offer" in msg &&
				typeof msg.offer === "string" &&
				"peerId" in msg &&
				typeof msg.peerId === "number"
			)
		)
			throw new Error();
		if (peers.some(p => p.peerId === msg.peerId)) return;
		const answer = await instantiate(msg.offer);
		peer.channel.send(JSON.stringify({ type: SOCIALIZE_BACK, answer, peerId: msg.peerId }));
	},
	[SOCIALIZE_BACK](peer, msg) {
		if (!("answer" in msg && typeof msg.answer === "string" && "peerId" in msg && typeof msg.peerId === "number"))
			throw new Error();
		const mutual = peers.find(p => p.peerId === msg.peerId);
		if (mutual === undefined) return;
		mutual.channel.send(JSON.stringify({ type: CONNECT, answer: msg.answer }));
	},
	[CONNECT](peer, msg) {
		if (!("answer" in msg && typeof msg.answer === "string")) throw new Error();
		answerSocialize?.(msg.answer);
		answerSocialize = undefined;
	},
	async [ASK_AROUND](peer, msg) {
		if (
			!(
				"signature" in msg &&
				typeof msg.signature === "string" &&
				"publicKey" in msg &&
				typeof msg.publicKey === "string" &&
				"offer" in msg &&
				typeof msg.offer === "string"
			)
		)
			throw new Error();

		if (!("path" in msg && Array.isArray(msg.path) && msg.path.every(p => typeof p === "number"))) throw new Error();

		if (mode !== true && msg.publicKey !== myPublicKey) throw new Error();

		let path = msg.path as number[];
		const originator = path[0];

		// verify the payload
		const identifier = originator + msg.offer;
		if (seen.has(identifier)) return;
		seen.add(identifier);

		const buffer = encoder.encode(identifier);
		const publicKeyBuffer = fromHex(msg.publicKey);
		const publicKey = await crypto.subtle.importKey("raw", publicKeyBuffer, { name: "Ed25519" }, false, ["verify"]);
		const signatureBuffer = fromHex(msg.signature);
		const verified = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signatureBuffer, buffer);
		if (!verified) throw new Error();

		if (mode === true) {
			const candidatePeer = peers.find(p => isFinite(peerId) && p.peerId !== originator && p.mode === msg.publicKey);
			if (candidatePeer !== undefined) {
				candidatePeer.channel.send(JSON.stringify(msg));
			} else {
				const smallestNecessary = path.findIndex(id => peers.some(p => id === p.peerId));
				if (smallestNecessary !== -1) path.splice(smallestNecessary + 1);
				path.push(peerId);

				broadcast(JSON.stringify(msg));
			}
		} else {
			// backtrack through the network
			const answer = await instantiate(msg.offer);
			const answerBuffer = encoder.encode(peerId + answer);
			const signatureBuffer = await crypto.subtle.sign({ name: "Ed25519" }, mode.privateKey, answerBuffer);
			const signature = toHex(new Uint8Array(signatureBuffer));

			peer.channel.send(
				JSON.stringify({ type: BACKTRACK, answer, originator: peerId, signature, publicKey: myPublicKey, path })
			);
		}
	},
	async [BACKTRACK](peer, msg) {
		if (
			!(
				"signature" in msg &&
				typeof msg.signature === "string" &&
				"publicKey" in msg &&
				typeof msg.publicKey === "string" &&
				"answer" in msg &&
				typeof msg.answer === "string" &&
				"originator" in msg &&
				typeof msg.originator === "number"
			)
		)
			throw new Error();

		if (!("path" in msg && Array.isArray(msg.path) && msg.path.every(p => typeof p === "number"))) throw new Error();

		const path = msg.path as number[];

		if (mode !== true && msg.publicKey !== myPublicKey) throw new Error();

		const buffer = encoder.encode(msg.originator + msg.answer);
		const publicKeyBuffer = fromHex(msg.publicKey);
		const publicKey = await crypto.subtle.importKey("raw", publicKeyBuffer, { name: "Ed25519" }, false, ["verify"]);
		const signatureBuffer = fromHex(msg.signature);
		const verified = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signatureBuffer, buffer);
		if (!verified) throw new Error();

		if (mode === true) {
			const nextPeerId = path.pop();
			const nextPeer = peers.find(p => p.peerId === nextPeerId);
			if (nextPeer === undefined) throw new Error();

			console.log(`backtracking through ${peer.debugName} -> ${debugName} -> ${nextPeer.debugName}`);
			console.log(path);

			nextPeer.channel.send(JSON.stringify(msg));
		} else {
			if (!peers.some(p => p.peerId === msg.originator)) finalConnect?.(msg.answer);
			finalConnect = undefined;
		}
	}
};

async function greet(channel: RTCDataChannel) {
	const peer = { channel, numContacts: Infinity, peerId: Infinity, debugName, mode: false };
	peers.push(peer);

	peer.channel.onmessage = function (e) {
		const msg = JSON.parse(e.data);
		handlers[msg.type]?.(peer, msg);
	};

	peer.channel.onclose = function () {
		console.log(`${debugName} closing ${peer.debugName}`);
		peers.splice(peers.indexOf(peer), 1);
	};

	broadcast(JSON.stringify({ type: INFO, num: peers.length }));

	if (mode === true) {
		peer.channel.send(JSON.stringify({ type: INFO, name: debugName, id: peerId, mode: true }));
	} else {
		peer.channel.send(JSON.stringify({ type: INFO, name: debugName, id: peerId, mode: myPublicKey }));

		let offer;
		[offer, finalConnect] = await instantiate();

		const buffer = encoder.encode(peerId + offer);
		const signatureBuffer = await crypto.subtle.sign({ name: "Ed25519" }, mode.privateKey, buffer);
		const signature = toHex(new Uint8Array(signatureBuffer));

		peer.channel.send(JSON.stringify({ type: ASK_AROUND, path: [peerId], signature, publicKey: myPublicKey, offer }));
	}
}
