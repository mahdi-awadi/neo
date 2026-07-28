// client.ts — typed fetch client for task-service v1.0.0
// Generated against api-contract.json. No external dependencies (standard fetch only).

// ---- Shared models ----

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Per-endpoint request/response types ----

// healthCheck: GET /health
export interface HealthCheckResponse {
  status: string;
}

// listTasks: GET /tasks
// (type alias, not interface, so it carries an implicit index signature for query serialization)
export type ListTasksQuery = {
  status?: string;
  limit?: number;
  offset?: number;
};
export interface ListTasksResponse {
  tasks: Task[];
  total: number;
}

// getTask: GET /tasks/:id
export interface GetTaskParams {
  id: string;
}
export interface GetTaskResponse {
  task: Task;
}

// createTask: POST /tasks
export interface CreateTaskBody {
  title: string;
  description?: string;
  dueDate?: string;
}
export interface CreateTaskResponse {
  task: Task;
}

// updateTask: PUT /tasks/:id
export interface UpdateTaskParams {
  id: string;
}
export interface UpdateTaskBody {
  title?: string;
  description?: string;
  status?: string;
  dueDate?: string;
}
export interface UpdateTaskResponse {
  task: Task;
}

// deleteTask: DELETE /tasks/:id
export interface DeleteTaskParams {
  id: string;
}
export interface DeleteTaskResponse {
  deleted: boolean;
  id: string;
}

// ---- Client ----

export interface ClientOptions {
  /** Base URL of the API, e.g. "https://api.example.com". Defaults to same-origin. */
  baseUrl?: string;
  /** Optional fetch override (e.g. for tests or custom headers). */
  fetch?: typeof fetch;
}

/** Query string values accepted by the client (concrete query types assign structurally). */
type QueryParams = Record<string, string | number | boolean | undefined>;

const CONTRACT_BASE_PATH = "/api/v1";

export class TaskServiceClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: ClientOptions = {}) {
    // Strip any trailing slash so we can concatenate cleanly.
    const root = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.baseUrl = root + CONTRACT_BASE_PATH;
    this.fetchFn = options.fetch ?? fetch;
  }

  private buildUrl(path: string, query?: QueryParams): string {
    let url = this.baseUrl + path;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: QueryParams; body?: unknown } = {},
  ): Promise<T> {
    const init: RequestInit = { method };
    if (opts.body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(opts.body);
    }
    const res = await this.fetchFn(this.buildUrl(path, opts.query), init);
    if (!res.ok) {
      throw new Error(`${method} ${path} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  /** GET /api/v1/health */
  healthCheck(): Promise<HealthCheckResponse> {
    return this.request<HealthCheckResponse>("GET", "/health");
  }

  /** GET /api/v1/tasks */
  listTasks(query: ListTasksQuery = {}): Promise<ListTasksResponse> {
    return this.request<ListTasksResponse>("GET", "/tasks", { query });
  }

  /** GET /api/v1/tasks/:id */
  getTask(params: GetTaskParams): Promise<GetTaskResponse> {
    return this.request<GetTaskResponse>(
      "GET",
      `/tasks/${encodeURIComponent(params.id)}`,
    );
  }

  /** POST /api/v1/tasks */
  createTask(body: CreateTaskBody): Promise<CreateTaskResponse> {
    return this.request<CreateTaskResponse>("POST", "/tasks", { body });
  }

  /** PUT /api/v1/tasks/:id */
  updateTask(
    params: UpdateTaskParams,
    body: UpdateTaskBody,
  ): Promise<UpdateTaskResponse> {
    return this.request<UpdateTaskResponse>(
      "PUT",
      `/tasks/${encodeURIComponent(params.id)}`,
      { body },
    );
  }

  /** DELETE /api/v1/tasks/:id */
  deleteTask(params: DeleteTaskParams): Promise<DeleteTaskResponse> {
    return this.request<DeleteTaskResponse>(
      "DELETE",
      `/tasks/${encodeURIComponent(params.id)}`,
    );
  }
}
