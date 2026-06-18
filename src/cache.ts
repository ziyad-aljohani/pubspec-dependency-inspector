const CACHE_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
	data: unknown;
	fetchedAt: number;
}

const packageCache = new Map<string, CacheEntry>();

export function getCachedPackageData(packageName: string): unknown | null {
	const entry = packageCache.get(packageName);
	if (!entry) {
		return null;
	}

	if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) {
		packageCache.delete(packageName);
		return null;
	}

	return entry.data;
}

export function setCachedPackageData(packageName: string, data: unknown): void {
	packageCache.set(packageName, {
		data,
		fetchedAt: Date.now(),
	});
}
