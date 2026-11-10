import type { GuardAlert, GuardReporting } from '../../src/guard-reporting.types.js';

type LoggedLine = {
  level: 'warn' | 'error';
  fields: Record<string, unknown>;
  message: string;
};

type RecordingReporting = GuardReporting & {
  lines: LoggedLine[];
  scheduledAlerts: GuardAlert[];
};

export function createRecordingReporting(): RecordingReporting {
  const lines: LoggedLine[] = [];
  const scheduledAlerts: GuardAlert[] = [];
  return {
    lines,
    scheduledAlerts,
    logger: {
      warn(fields, message) {
        lines.push({ level: 'warn', fields, message });
      },
      error(fields, message) {
        lines.push({ level: 'error', fields, message });
      },
    },
    alerts: {
      scheduleOpsAlert(alert) {
        scheduledAlerts.push(alert);
      },
    },
  };
}
