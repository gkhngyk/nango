import type { Result } from '@nangohq/utils';
import { Err, stringifyError, getLogger } from '@nangohq/utils';
import type { OrchestratorClient } from './client.js';
import type { OrchestratorTask } from './types.js';
import type { JsonValue } from 'type-fest';
import PQueue from 'p-queue';

const logger = getLogger('orchestrator.clients.processor');

export class OrchestratorProcessor {
    private handler: (task: OrchestratorTask) => Promise<Result<JsonValue>>;
    private groupKey: string;
    private orchestratorClient: OrchestratorClient;
    private queue: PQueue;
    private stopped: boolean;
    private abortControllers: Map<string, AbortController>;
    private terminatedTimer: NodeJS.Timeout | null = null;
    private checkForTerminatedInterval: number;

    constructor({
        handler,
        opts
    }: {
        handler: (task: OrchestratorTask) => Promise<Result<JsonValue>>;
        opts: { orchestratorClient: OrchestratorClient; groupKey: string; maxConcurrency: number; checkForTerminatedInterval?: number };
    }) {
        this.stopped = true;
        this.handler = handler;
        this.groupKey = opts.groupKey;
        this.orchestratorClient = opts.orchestratorClient;
        this.queue = new PQueue({ concurrency: opts.maxConcurrency });
        this.abortControllers = new Map();
        this.checkForTerminatedInterval = opts.checkForTerminatedInterval || 1000;
    }

    public start() {
        this.stopped = false;
        this.terminatedTimer = setInterval(async () => {
            await this.checkForTerminatedTasks();
        }, this.checkForTerminatedInterval); // checking for cancelled/expired doesn't require to be very responsive so we can do it on an interval
        void this.processingLoop();
    }

    public stop() {
        this.stopped = true;
        if (this.terminatedTimer) {
            clearInterval(this.terminatedTimer);
        }
    }

    private async checkForTerminatedTasks() {
        if (this.stopped || this.abortControllers.size <= 0) {
            return;
        }
        const ids = Array.from(this.abortControllers.keys());
        const search = await this.orchestratorClient.search({ ids });
        if (search.isErr()) {
            return Err(search.error);
        }
        for (const task of search.value) {
            // if task is already in a terminal state, invoke the abort signal
            if (['FAILED', 'EXPIRED', 'CANCELLED', 'SUCCEEDED'].includes(task.state)) {
                const abortController = this.abortControllers.get(task.id);
                if (abortController) {
                    if (!abortController.signal.aborted) {
                        abortController.abort();
                    }
                    this.abortControllers.delete(task.id);
                }
            }
        }
        return;
    }

    private async processingLoop() {
        while (!this.stopped) {
            // wait for the queue to have space before dequeuing more tasks
            await this.queue.onSizeLessThan(this.queue.concurrency);
            const available = this.queue.concurrency - this.queue.size;
            const limit = available + this.queue.concurrency; // fetching more than available to keep the queue full
            const tasks = await this.orchestratorClient.dequeue({ groupKey: this.groupKey, limit, longPolling: true });
            if (tasks.isErr()) {
                logger.error(`failed to dequeue tasks: ${stringifyError(tasks.error)}`);
                await new Promise((resolve) => setTimeout(resolve, 1000)); // wait for a bit before retrying to avoid hammering the server in case of repetitive errors
                continue;
            }
            for (const task of tasks.value) {
                void this.processTask(task);
            }
        }
        return;
    }

    private async processTask(task: OrchestratorTask): Promise<void> {
        this.abortControllers.set(task.id, task.abortController);
        await this.queue.add(async () => {
            try {
                if (task.abortController.signal.aborted) {
                    // task was aborted while waiting in the queue
                    return;
                }
                const res = await this.handler(task);
                if (res.isErr()) {
                    await this.orchestratorClient.failed({ taskId: task.id, error: res.error });
                } else {
                    await this.orchestratorClient.succeed({ taskId: task.id, output: res.value });
                }
            } catch (err: unknown) {
                const error = new Error(stringifyError(err));
                await this.orchestratorClient.failed({ taskId: task.id, error });
            } finally {
                this.abortControllers.delete(task.id);
            }
        });
    }
}