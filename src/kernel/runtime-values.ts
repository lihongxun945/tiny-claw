import type { MessageHistory } from "../history.js";
import type { ModelClient } from "../model/index.js";
import type { Config, ExecutionMode, SessionContext } from "../types.js";
import { scopeValue, type TurnScope } from "./scope.js";

export interface SessionRuntimeDependencies {
  config: Config;
  client: ModelClient;
  history: MessageHistory;
  sessionContext: SessionContext;
}

export const SESSION_RUNTIME = scopeValue<SessionRuntimeDependencies>("session runtime dependencies");
export const ACTIVE_TURN_SCOPE = scopeValue<TurnScope>("active turn scope");
export const TURN_EXECUTION_MODE = scopeValue<ExecutionMode>("turn execution mode");
