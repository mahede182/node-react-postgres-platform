import { Worker } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  "item-events",
  async (job) => {
    console.log(`processing ${job.name}`, job.data);
  },
  { connection }
);

worker.on("completed", (job) => console.log(`job ${job.id} completed`));
worker.on("failed", (job, err) => {
  console.error(`job ${job?.id} failed:`, err.message);
});

console.log("worker started, waiting for jobs on 'item-events'");
