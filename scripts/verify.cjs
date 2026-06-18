/**
 * Smoke test: parser + cached network against a real pubspec.
 */
const fs = require('fs');
const axios = require('axios');

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();

function getCached(name) {
	const entry = cache.get(name);
	if (!entry) {
		return null;
	}
	if (Date.now() - entry.at >= CACHE_TTL_MS) {
		cache.delete(name);
		return null;
	}
	return entry.data;
}

function setCached(name, data) {
	cache.set(name, { data, at: Date.now() });
}

async function fetchPackage(name) {
	const cached = getCached(name);
	if (cached) {
		return cached;
	}
	const res = await axios.get(`https://pub.dev/api/packages/${name}`, {
		timeout: 15000,
	});
	setCached(name, res.data);
	return res.data;
}

const REGEX = /^\s*(?!version|sdk|ref)\S+:\s*[<=>|^]*([0-9]+\.[0-9]+\.[0-9]+\+?\S*)/;
const VERSION_REGEX = /\^*(\d+\.\d+\.\d+)(\+\d)*/;

function readDeps(content) {
	const deps = [];
	let line = '';
	let reached = false;
	for (const char of content) {
		if (char === '\n' || char === '\r') {
			if (line === 'dependencies:') {
				reached = true;
			}
			if (!line.startsWith('#') && REGEX.test(line) && reached) {
				const name = line.split(':')[0].trim();
				deps.push(name);
			}
			line = '';
		} else {
			line += char;
		}
	}
	return deps;
}

async function main() {
	const pubspec =
		process.argv[2] ||
		'/Users/ziyad/Desktop/flutter_apps/Rain Maps/rain_radar/pubspec.yaml';

	if (!fs.existsSync(pubspec)) {
		console.error(`FAIL: pubspec not found at ${pubspec}`);
		process.exit(1);
	}

	const content = fs.readFileSync(pubspec, 'utf8');
	const deps = readDeps(content);

	if (deps.length === 0) {
		console.error('FAIL: no dependencies parsed');
		process.exit(1);
	}

	console.log(`PASS: parsed ${deps.length} dependencies`);

	const sample = deps[0];
	const data = await fetchPackage(sample);
	if (!data?.latest?.version) {
		console.error(`FAIL: could not fetch latest version for ${sample}`);
		process.exit(1);
	}

	console.log(`PASS: fetched ${sample}@${data.latest.version}`);

	const t0 = Date.now();
	await fetchPackage(sample);
	const cachedMs = Date.now() - t0;

	if (cachedMs > 50) {
		console.error(`FAIL: cache miss took ${cachedMs}ms`);
		process.exit(1);
	}

	console.log(`PASS: cache hit in ${cachedMs}ms`);
	console.log('All checks passed.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
