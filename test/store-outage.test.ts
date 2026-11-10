import { describe, expect, it } from 'vitest';
import { createStoreOutageReporter } from '../src/store-outage.js';
import { createRecordingReporting } from './fakes/reporting.js';

const START = Date.UTC(2026, 10, 10, 12, 0, 0);

describe('createStoreOutageReporter', () => {
  it('reports again once the clock is behind the last report, instead of staying silent', () => {
    const reporting = createRecordingReporting();
    const reportStoreOutage = createStoreOutageReporter(reporting);
    const report = (now: number) =>
      reportStoreOutage({
        throttleKey: 'signup',
        logMessage: 'rate_limit_refused_store_unavailable',
        fields: {},
        alert: { alertType: 'rate_limit_store_unavailable', title: 'down' },
        now,
      });

    report(START + 60 * 60 * 1000);
    report(START);

    expect(reporting.scheduledAlerts).toHaveLength(2);
  });
});
