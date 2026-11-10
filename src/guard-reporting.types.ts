/** The shape of a pino logger's `warn` and `error`, so an app passes its own logger as is. */
export type GuardLogger = {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};

export type GuardAlert = {
  alertType: string;
  title: string;
};

/** Where a guard reports what it refused; `alerts` takes an observability instance as is. */
export type GuardReporting = {
  logger: GuardLogger;
  alerts: { scheduleOpsAlert(alert: GuardAlert): void };
};
