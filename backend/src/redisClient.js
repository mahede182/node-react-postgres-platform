import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 2,
  lazyConnect: true,
  enableOfflineQueue: false,
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(times * 200, 2000);
  },
});

let lastErrorAt = 0;

redis.on("error", (err) => {
  const now = Date.now();
  if (now - lastErrorAt < 10_000) return;
  lastErrorAt = now;
  console.error("redis connection error:", err.message);
});

export async function ensureRedis() {
  if (redis.status === "wait") {
    await redis.connect();
  }
}

export default redis;
