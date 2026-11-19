/**
 * KubeOS "Rebalance" page: move pods off the nodes that carry too many onto the nodes that have
 * room.
 *
 * WHY THIS PAGE EXISTS: Kubernetes decides a pod's node ONCE, when the pod is created, and no
 * default component ever revisits it. Removing a node therefore works nicely - its pods are
 * deleted and their controller recreates them elsewhere - but adding a node (or re-joining one)
 * changes nothing: the running pods stay where they were, the new machine stays empty, and
 * `topologySpreadConstraints` never gets a say because it is only consulted while scheduling a
 * NEW pod. Measured on a 4-node KubeOS cluster (2026-11-13): 2/2/0/0 with every node Ready, no
 * taints and no cordons. The user's conclusion was exactly right; this is the deliberate action
 * that fixes it without a balancer daemon.
 *
 * WHAT A CLICK DOES: the gateway (`/kubeos-rebalance`) computes which pods are on an over-full
 * node, deletes ONLY those, and stops there. The workload's own controller recreates them, which
 * is the same mechanism that makes a removed node's pods reappear - so KubeOS creates no Pod of
 * its own, and the pods that are already well placed never restart.
 *
 * HONEST LIMITS, shown on the page: a bare pod (no Deployment/StatefulSet behind it) cannot be
 * moved at all, because nothing would recreate it; and this moves pods, it does not change the
 * number of replicas.
 */
import { registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import React from 'react';

interface Workload {
  kind: string;
  namespace: string;
  name: string;
  replicas: number;
  ready: number;
  placement: Record<string, number>;
  would_move: number;
}

interface Plan {
  ok: boolean;
  workloads: Workload[];
  would_move: number;
  bare_pods: number;
  error?: string;
}

interface MovedPod {
  namespace: string;
  pod: string;
  workload: string;
}

interface ActResult {
  ok: boolean;
  moved: MovedPod[];
  failed: { pod?: string; workload?: string; error: string }[];
  bare_pods: number;
  error?: string;
}

const ENDPOINT = '/kubeos-rebalance';

async function readPlan(): Promise<Plan> {
  const answer = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
  const body = (await answer.json()) as Plan;
  if (!answer.ok || body.ok === false) {
    throw new Error(body.error || `the gateway answered ${answer.status}`);
  }
  return body;
}

async function act(): Promise<ActResult> {
  const answer = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  const body = (await answer.json()) as ActResult;
  if (!answer.ok || body.ok === false) {
    throw new Error(body.error || `the gateway answered ${answer.status}`);
  }
  return body;
}

function placementText(placement: Record<string, number>): string {
  const parts = Object.entries(placement)
    .sort((left, right) => right[1] - left[1])
    .map(([node, count]) => `${node} ×${count}`);
  return parts.length === 0 ? 'no pods yet' : parts.join(', ');
}

function RebalancePage() {
  const [plan, setPlan] = React.useState<Plan | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [asking, setAsking] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<ActResult | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPlan(await readPlan());
    } catch (reason: any) {
      setPlan(null);
      setError(String(reason?.message ?? reason));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const run = async () => {
    setAsking(false);
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await act());
      setPlan(await readPlan());
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
    } finally {
      setRunning(false);
    }
  };

  const move = plan?.would_move ?? 0;
  const bare = plan?.bare_pods ?? 0;

  return (
    <>
      <SectionBox title="Spread the pods over the nodes">
        <Typography variant="body2" sx={{ mb: 2, opacity: 0.85 }}>
          Kubernetes picks a node <strong>once</strong>, when a pod is created, and never moves it
          afterwards. That is why removing a node works (its pods are recreated elsewhere) while
          adding one changes nothing: the running pods stay put and the new machine stays empty.
          This page moves the pods that sit on over-full nodes - only those - and their own
          Deployment or StatefulSet recreates them, so <strong>no Pod is created by KubeOS</strong>{' '}
          and the well-placed pods never restart.
        </Typography>

        {loading && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size={16} sx={{ color: '#c4ff2e' }} />
            <Typography variant="body2">reading the cluster&hellip;</Typography>
          </Box>
        )}

        {error && (
          <Typography color="error" sx={{ mt: 1 }}>
            {error}
          </Typography>
        )}

        {plan && (
          <Box sx={{ mt: 1 }}>
            <Box
              component="table"
              sx={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}
            >
              <Box component="thead">
                <Box component="tr">
                  <Box component="th" sx={{ p: 0.5, textAlign: 'left', opacity: 0.7 }}>
                    workload
                  </Box>
                  <Box component="th" sx={{ p: 0.5, textAlign: 'left', opacity: 0.7 }}>
                    ready
                  </Box>
                  <Box component="th" sx={{ p: 0.5, textAlign: 'left', opacity: 0.7 }}>
                    pods per node
                  </Box>
                  <Box component="th" sx={{ p: 0.5, textAlign: 'left', opacity: 0.7 }}>
                    would move
                  </Box>
                </Box>
              </Box>
              <Box component="tbody">
                {plan.workloads.map(workload => (
                  <Box
                    component="tr"
                    key={`${workload.namespace}/${workload.kind}/${workload.name}`}
                    sx={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}
                  >
                    <Box component="td" sx={{ p: 0.5 }}>
                      {workload.kind}/{workload.name}
                      <Typography variant="caption" sx={{ display: 'block', opacity: 0.6 }}>
                        {workload.namespace}
                      </Typography>
                    </Box>
                    <Box component="td" sx={{ p: 0.5 }}>
                      {workload.ready}/{workload.replicas}
                    </Box>
                    <Box component="td" sx={{ p: 0.5 }}>
                      {placementText(workload.placement)}
                    </Box>
                    <Box
                      component="td"
                      sx={{ p: 0.5, color: workload.would_move > 0 ? '#c4ff2e' : 'inherit' }}
                    >
                      {workload.would_move}
                    </Box>
                  </Box>
                ))}
                {plan.workloads.length === 0 && (
                  <Box component="tr">
                    <Box component="td" colSpan={4} sx={{ p: 0.5, opacity: 0.7 }}>
                      No Deployments or StatefulSets with replicas - nothing to rebalance.
                    </Box>
                  </Box>
                )}
              </Box>
            </Box>

            <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', mt: 2 }}>
              <Button
                variant="contained"
                disabled={move === 0 || running}
                onClick={() => setAsking(true)}
              >
                {running ? 'Moving…' : move === 0 ? 'Already spread' : `Move ${move} pod(s)`}
              </Button>
              <Button variant="outlined" onClick={load} disabled={loading || running}>
                Refresh
              </Button>
              {bare > 0 && (
                <Typography variant="caption" sx={{ opacity: 0.7 }}>
                  {bare} bare pod(s) cannot move: nothing would recreate them.
                </Typography>
              )}
            </Box>
          </Box>
        )}

        {result && (
          <Box sx={{ mt: 2, p: 1.5, borderRadius: 1, border: '1px solid rgba(196,255,46,0.35)' }}>
            <Typography variant="body2" sx={{ fontWeight: 600, color: '#c4ff2e' }}>
              {result.moved.length === 0
                ? 'Nothing needed to move.'
                : `Moving ${result.moved.length} pod(s) - they appear on the free nodes within a few seconds.`}
            </Typography>
            {result.moved.map(pod => (
              <Typography
                key={pod.pod}
                variant="caption"
                sx={{ display: 'block', opacity: 0.8 }}
              >
                {pod.workload} · {pod.namespace}/{pod.pod}
              </Typography>
            ))}
            {result.failed?.map(failure => (
              <Typography
                key={`${failure.pod}`}
                variant="caption"
                color="error"
                sx={{ display: 'block' }}
              >
                {failure.workload || failure.pod}: {failure.error}
              </Typography>
            ))}
          </Box>
        )}
      </SectionBox>

      <Dialog open={asking} onClose={() => setAsking(false)}>
        <DialogTitle>Move {move} pod(s)?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The pods on over-full nodes are deleted and their own Deployment or StatefulSet
            recreates them, so they land on the nodes that are empty. A workload with a single
            replica is unavailable for the few seconds that takes. The rest keep running.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAsking(false)}>Cancel</Button>
          <Button variant="contained" onClick={run}>
            Move them
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

registerSidebarEntry({
  parent: null,
  name: 'kubeos-rebalance',
  label: 'Rebalance',
  url: '/kubeos-rebalance',
  icon: 'mdi:scale-balance',
});

registerRoute({
  path: '/kubeos-rebalance',
  sidebar: 'kubeos-rebalance',
  name: 'kubeos-rebalance',
  exact: true,
  component: RebalancePage,
});
