import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";

export type Metrics = {
  registry: Registry;
  wsConnections: Gauge<string>;
  wsConnectionsTotal: Counter<string>;
  wsCloseTotal: Counter<string>;
  slackEventsTotal: Counter<string>;
  slackRpcTotal: Counter<string>;
  pairingsCreatedTotal: Counter<string>;
  pairingsConsumedTotal: Counter<string>;
};

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const wsConnections = new Gauge({
    name: "ws_connections",
    help: "Currently connected client machines",
    registers: [registry],
  });
  const wsConnectionsTotal = new Counter({
    name: "ws_connections_total",
    help: "Total accepted client WebSocket connections",
    registers: [registry],
  });
  const wsCloseTotal = new Counter({
    name: "ws_close_total",
    help: "WebSocket close events bucketed by close code",
    labelNames: ["code"],
    registers: [registry],
  });
  const slackEventsTotal = new Counter({
    name: "slack_events_total",
    help: "Slack events received from Bolt",
    labelNames: ["kind"],
    registers: [registry],
  });
  const slackRpcTotal = new Counter({
    name: "slack_rpc_total",
    help: "Slack RPC calls fanned out to clients",
    labelNames: ["method", "status"],
    registers: [registry],
  });
  const pairingsCreatedTotal = new Counter({
    name: "pairings_created_total",
    help: "Pairing codes issued via DM",
    registers: [registry],
  });
  const pairingsConsumedTotal = new Counter({
    name: "pairings_consumed_total",
    help: "Pairing codes successfully consumed via /pair",
    registers: [registry],
  });

  return {
    registry,
    wsConnections,
    wsConnectionsTotal,
    wsCloseTotal,
    slackEventsTotal,
    slackRpcTotal,
    pairingsCreatedTotal,
    pairingsConsumedTotal,
  };
}
