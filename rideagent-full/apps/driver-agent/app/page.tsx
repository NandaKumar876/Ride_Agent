"use client";
import { useState, useEffect, useCallback } from "react";
import { DRIVER_AGENT, RIDER_AGENT, calculateFare } from "@rideagent/shared";

interface Log    { time: string; tag: "DRIVER"|"RIDER"|"x402"|"SYS"; type: "ok"|"warn"|"err"|"info"; msg: string; }
interface LedgerEntry { channelId: string; rideId: string; totalReceived: number; checkpointsDone: number; checkpointsTotal: number; settled: boolean; }
interface Ride        { rideId: string; riderWallet: string; from: string; to: string; fareBtc: number; km: number; channelId: string|null; status: string; createdAt: number; }

function now()  { return new Date().toLocaleTimeString("en-GB"); }
function short(a: string) { return `${a.slice(0,8)}...${a.slice(-4)}`; }

export default function DriverPage() {
  const [rides,      setRides]      = useState<Ride[]>([]);
  const [channels,   setChannels]   = useState<LedgerEntry[]>([]);
  const [logs,       setLogs]       = useState<Log[]>([]);

  useEffect(() => {
    setLogs([
      { time: now(), tag: "SYS",    type: "info", msg: `DriverAgent online — wallet ${short(DRIVER_AGENT.wallet)}` },
      { time: now(), tag: "DRIVER", type: "ok",   msg: "Listening for ride requests on /api/accept" },
      { time: now(), tag: "DRIVER", type: "info", msg: `Rep score: 96.1 | ERC-8004 #${DRIVER_AGENT.tokenId}` },
    ]);
  }, []);
  const [totalEarned, setTotalEarned] = useState(0);
  const [activeChannel, setActiveChannel] = useState<LedgerEntry | null>(null);
  const [walletAddress, setWalletAddress] = useState<string>(DRIVER_AGENT.wallet);

  async function connectWallet() {
    if (typeof window !== "undefined" && (window as any).ethereum) {
      try {
        const accounts = await (window as any).ethereum.request({ method: "eth_requestAccounts" });
        if (accounts && accounts.length > 0) {
          setWalletAddress(accounts[0]);
          addLog("SYS", "ok", `Connected wallet: ${short(accounts[0])}`);
          
          // Switch to GOAT testnet3
          try {
            await (window as any).ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: '0xbeb0' }], // GOAT's known ID 
            });
            addLog("SYS", "ok", "Switched to GOAT testnet3");
          } catch (switchError: any) {
            try {
              await (window as any).ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [
                  {
                    chainId: '0xbeb0',
                    chainName: 'GOAT Network Testnet3',
                    rpcUrls: ['https://rpc.testnet3.goat.network'],
                    nativeCurrency: { name: 'GOAT', symbol: 'GOAT', decimals: 18 },
                    blockExplorerUrls: ['https://explorer.testnet3.goat.network']
                  },
                ],
              });
              addLog("SYS", "ok", "Added and switched to GOAT testnet3");
            } catch (addError) {
              addLog("SYS", "err", `Failed to add GOAT network. Please add manually.`);
            }
          }
        }
      } catch (err) {
        addLog("SYS", "err", `Wallet connection failed: ${String(err)}`);
      }
    } else {
      addLog("SYS", "warn", "No Web3 wallet found (e.g., MetaMask).");
    }
  }

  const addLog = useCallback((tag: Log["tag"], type: Log["type"], msg: string) => {
    setLogs(prev => [...prev, { time: now(), tag, type, msg }]);
  }, []);

  // Poll ride store and payment ledger every 2s
  const poll = useCallback(async () => {
    try {
      const [rideRes, webhookRes] = await Promise.all([
        fetch("/api/accept"),
        fetch("/api/webhook"),
      ]);
      const rideData    = await rideRes.json();
      const webhookData = await webhookRes.json();

      const newRides    = rideData.rides    || [];
      const newChannels = webhookData.channels || [];
      const newEarned   = webhookData.summary?.totalBtcEarned || 0;

      setRides(prev => {
        // Detect newly arrived rides and log them
        const prevIds = new Set(prev.map((r: Ride) => r.rideId));
        newRides.forEach((r: Ride) => {
          if (!prevIds.has(r.rideId)) {
            addLog("RIDER",  "info", `New ride request: ${r.from} → ${r.to}`);
            addLog("DRIVER", "ok",   `Sent HTTP 402 — fare: ${r.fareBtc.toFixed(2)} BTC`);
          }
          if (!prevIds.has(r.rideId) && r.status === "PAYMENT_CONFIRMED") {
            addLog("x402",   "ok",   `Payment proof verified — ride ${r.rideId} accepted`);
          }
        });
        return newRides;
      });

      setChannels(prev => {
        const prevMap = new Map(prev.map((c: LedgerEntry) => [c.channelId, c]));
        newChannels.forEach((c: LedgerEntry) => {
          const old = prevMap.get(c.channelId);
          if (old && c.checkpointsDone > old.checkpointsDone) {
            const perCp = c.totalReceived / Math.max(c.checkpointsDone, 1);
            addLog("x402",   "ok",   `Checkpoint ${c.checkpointsDone}/${c.checkpointsTotal} — +${perCp.toFixed(4)} BTC received`);
          }
          if (old && !old.settled && c.settled) {
            addLog("DRIVER", "ok",   `Channel ${c.channelId.slice(0,12)}... SETTLED — ${c.totalReceived.toFixed(2)} BTC total`);
            addLog("SYS",    "ok",   "ERC-8004 reputation score update queued on-chain");
          }
        });
        const latest = newChannels.find((c: LedgerEntry) => !c.settled) || newChannels[newChannels.length - 1];
        if (latest) setActiveChannel(latest);
        return newChannels;
      });

      setTotalEarned(newEarned);
    } catch { /* server may not be ready yet */ }
  }, [addLog]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [poll]);

  const activeRide    = rides.find(r => r.status === "PAYMENT_CONFIRMED" || r.status === "PAYMENT_REQUESTED" || r.status === "PAYMENT_STREAMING");
  const pendingRides  = rides.filter(r => r.status === "PENDING_REVIEW");
  const settledCount  = channels.filter(c => c.settled).length;

  async function handleRideAction(rideId: string, action: "ACCEPT"|"REJECT") {
    try {
      addLog("DRIVER", "info", `${action === "ACCEPT" ? "Accepting" : "Rejecting"} ride request ${rideId.slice(0, 8)}...`);
      const res = await fetch("/api/accept", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rideId, action }),
      });
      const data = await res.json();
      if (data.success) {
        addLog("DRIVER", "ok", `Successfully ${action === "ACCEPT" ? "accepted (awaiting payment proof)" : "rejected"} ride.`);
        poll(); // refresh UI immediately
      } else {
        addLog("DRIVER", "err", `Failed to ${action.toLowerCase()} ride: ${data.error}`);
      }
    } catch (e) {
      addLog("DRIVER", "err", `Error connecting to API: ${String(e)}`);
    }
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-[#111827] via-[#0a0e1a] to-[#0a0e1a] font-sans selection:bg-accent/30">
      {/* Header */}
      <header className="bg-surface/60 backdrop-blur-md border-b border-white/5 px-6 py-3 flex items-center justify-between sticky top-0 z-20 shadow-lg shadow-black/20">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent/20 border border-accent/40 flex items-center justify-center">
            <span className="text-accent font-mono text-[11px] font-bold">D</span>
          </div>
          <div>
            <p className="font-mono text-sm md:text-base text-text font-bold">DriverAgent</p>
            <div className="flex items-center gap-1.5 md:gap-2">
              <p className="font-mono text-[8.5px] md:text-[10px] text-muted">{short(walletAddress)}</p>
              <button onClick={connectWallet} className={`font-mono text-[8.5px] md:text-[9px] border px-1.5 rounded transition-colors ${walletAddress !== DRIVER_AGENT.wallet ? "text-green border-green/50 hover:bg-green/10" : "text-accent border-accent/50 hover:bg-accent/10"}`}>
                {walletAddress !== DRIVER_AGENT.wallet ? "Connected" : "Connect"}
              </button>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 md:gap-2">
          <span className={`w-1.5 h-1.5 md:w-2 md:h-2 rounded-full pulse ${activeChannel && !activeChannel.settled ? "bg-accent" : "bg-muted"}`} />
          <span className="font-mono text-[9px] md:text-[11px] text-accent">
            {activeChannel && !activeChannel.settled ? "STREAMING" : "AVAILABLE"}
          </span>
          <span className="font-mono text-[8.5px] md:text-[10px] text-muted border border-border px-1.5 md:px-2 py-0.5 rounded">port 4001</span>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-3 md:px-4 py-4 md:py-5 flex flex-col md:grid md:grid-cols-2 gap-4">
        {/* LEFT: Stats + Active ride */}
        <div className="space-y-4">
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2.5">
            {[
              { label: "Total Earned",    value: `${totalEarned.toFixed(2)}`,  unit: "BTC", color: "text-accent"  },
              { label: "Rides Done",      value: `${settledCount}`,            unit: "rides", color: "text-blue"   },
              { label: "Rep Score",       value: "96.1",                       unit: "/ 100", color: "text-warn"   },
            ].map(s => (
              <div key={s.label} className="bg-card/80 backdrop-blur-sm border border-white/5 rounded-2xl p-4 shadow-xl shadow-black/40 transition-all hover:border-white/10 flex flex-col items-center text-center">
                <p className="font-mono text-[10px] text-muted uppercase tracking-wider mb-2">{s.label}</p>
                <p className={`font-mono text-2xl font-bold ${s.color}`}>{s.value}</p>
                <p className="font-mono text-[10px] text-muted mt-1">{s.unit}</p>
              </div>
            ))}
          </div>

          {/* Pending Ride Requests */}
          {pendingRides.length > 0 && !activeRide && (
            <div className="bg-card/80 backdrop-blur-sm border border-warn/30 rounded-2xl p-5 shadow-[0_0_30px_rgba(234,179,8,0.1)] fade-up">
              <div className="flex items-center justify-between mb-4">
                <p className="font-mono text-[11px] text-warn font-semibold uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse"></span>
                  Action Required: Pending Request
                </p>
              </div>
              {pendingRides.map(pr => (
                <div key={pr.rideId} className="space-y-3 border border-white/5 bg-black/40 p-3 rounded-xl mb-3 last:mb-0">
                  <div className="flex justify-between">
                     <span className="text-[11px] text-muted">From</span>
                     <span className="font-mono text-[11px]">{pr.from}</span>
                  </div>
                  <div className="flex justify-between">
                     <span className="text-[11px] text-muted">To</span>
                     <span className="font-mono text-[11px]">{pr.to}</span>
                  </div>
                  <div className="flex justify-between">
                     <span className="text-[11px] text-muted">Est. Fare</span>
                     <span className="font-mono text-[11px] text-accent">{pr.fareBtc.toFixed(2)} BTC</span>
                  </div>
                  <div className="flex justify-between">
                     <span className="text-[11px] text-muted">Distance</span>
                     <span className="font-mono text-[11px]">{pr.km.toFixed(1)} km</span>
                  </div>
                  <div className="flex gap-2 mt-3 pt-2 border-t border-white/5">
                    <button onClick={() => handleRideAction(pr.rideId, "ACCEPT")} className="flex-[2] py-2 rounded bg-green/20 text-green border border-green/50 hover:bg-green/30 font-mono text-[11px] font-bold transition-colors">
                      Accept Ride
                    </button>
                    <button onClick={() => handleRideAction(pr.rideId, "REJECT")} className="flex-1 py-2 rounded bg-danger/20 text-danger border border-danger/50 hover:bg-danger/30 font-mono text-[11px] font-bold transition-colors">
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Active ride card */}
          {activeRide ? (
            <div className="bg-card/80 backdrop-blur-sm border border-accent/20 rounded-2xl p-5 shadow-[0_0_30px_rgba(0,212,170,0.1)] fade-up">
              <div className="flex items-center justify-between mb-4">
                <p className="font-mono text-[11px] text-accent font-semibold uppercase tracking-widest flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"></span>
                  Active Ride
                </p>
                <span className="font-mono text-[10px] text-accent border border-accent/30 bg-accent/10 px-2 py-0.5 rounded">
                  {activeRide.status}
                </span>
              </div>
              <div className="space-y-1.5 mb-3">
                {[
                  ["Ride ID",     activeRide.rideId],
                  ["From",        activeRide.from],
                  ["To",          activeRide.to],
                  ["Fare",        `${activeRide.fareBtc.toFixed(2)} BTC`],
                  ["Distance",    `${activeRide.km.toFixed(1)} km`],
                  ["Rider",       short(activeRide.riderWallet)],
                  ["Channel",     activeRide.channelId ? activeRide.channelId.slice(0,18)+"..." : "pending"],
                ].map(([l, v]) => (
                  <div key={l} className="flex justify-between">
                    <span className="text-[11px] text-muted">{l}</span>
                    <span className="font-mono text-[11px]">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : pendingRides.length === 0 ? (
            <div className="bg-card/80 backdrop-blur-sm border border-white/5 rounded-2xl p-8 flex flex-col items-center justify-center text-center shadow-2xl shadow-black/40 fade-up">
              <span className="text-3xl mb-3 opacity-50">📡</span>
              <p className="font-mono text-[11px] text-white/70 mb-1.5">Waiting for ride request...</p>
              <p className="text-[12px] text-muted">Send a request from RiderAgent (port 4000)</p>
            </div>
          ) : null}

          {/* Active payment channel */}
          {activeChannel && (
            <div className="bg-card/80 backdrop-blur-sm border border-white/5 rounded-2xl p-5 shadow-2xl shadow-black/40 transition-all hover:border-white/10 fade-up">
              <p className="font-mono text-[11px] text-muted uppercase tracking-widest mb-4">Payment Channel</p>
              <div className="mb-3">
                <div className="flex justify-between text-[11px] mb-1.5">
                  <span className="text-muted font-mono">Received</span>
                  <span className="font-mono text-accent">
                    {activeChannel.totalReceived.toFixed(4)} BTC
                  </span>
                </div>
                <div className="h-2 bg-border rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-blue to-accent rounded-full transition-all duration-500"
                    style={{ width: `${activeChannel.checkpointsTotal > 0 ? Math.round(activeChannel.checkpointsDone / activeChannel.checkpointsTotal * 100) : 0}%` }} />
                </div>
                <div className="flex justify-between text-[10px] mt-1 text-muted font-mono">
                  <span>Checkpoint {activeChannel.checkpointsDone}/{activeChannel.checkpointsTotal}</span>
                  <span className={activeChannel.settled ? "text-accent" : ""}>
                    {activeChannel.settled ? "SETTLED ✓" : "STREAMING"}
                  </span>
                </div>
              </div>
              <div className="space-y-1">
                {[
                  ["Channel ID",  activeChannel.channelId.slice(0,18)+"..."],
                  ["Ride ID",     activeChannel.rideId],
                  ["Status",      activeChannel.settled ? "SETTLED" : "STREAMING"],
                ].map(([l, v]) => (
                  <div key={l} className="flex justify-between">
                    <span className="text-[11px] text-muted">{l}</span>
                    <span className={`font-mono text-[11px] ${v === "SETTLED" ? "text-accent" : "text-text"}`}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Past rides */}
          {rides.length > 0 && (
            <div className="bg-card/80 backdrop-blur-sm border border-white/5 rounded-2xl p-5 shadow-2xl shadow-black/40 transition-all hover:border-white/10 mt-4">
              <p className="font-mono text-[11px] text-muted uppercase tracking-widest mb-4">Ride History</p>
              <div className="space-y-2">
                {rides.slice().reverse().map(r => (
                  <div key={r.rideId} className="flex items-center gap-2 py-2 border-b border-border last:border-0">
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${r.status === "PAYMENT_CONFIRMED" ? "bg-accent" : r.status === "PAYMENT_REQUESTED" ? "bg-warn" : "bg-muted"}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] truncate">{r.from} → {r.to}</p>
                      <p className="font-mono text-[10px] text-muted">{r.rideId}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="font-mono text-[11px] text-accent">{r.fareBtc.toFixed(2)} BTC</p>
                      <p className="font-mono text-[10px] text-muted">{r.status.replace("_", " ")}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: Earnings ledger + Logs */}
        <div className="space-y-4">
          {/* x402 Protocol explainer */}
          <div className="bg-card/80 backdrop-blur-sm border border-white/5 rounded-2xl p-5 shadow-2xl shadow-black/40 transition-all hover:border-white/10">
            <p className="font-mono text-[11px] text-muted uppercase tracking-widest mb-4">x402 Flow — Driver Side</p>
            <div className="space-y-2">
              {[
                { step: "1", title: "Receive POST /api/accept",     desc: "Rider agent sends ride request",              active: rides.some(r => r.status === "PAYMENT_REQUESTED") },
                { step: "2", title: "Return HTTP 402",              desc: "X-Payment-Request header with fare terms",     active: false },
                { step: "3", title: "Receive X-Payment header",     desc: "EIP-712 permit proves BTC locked in escrow",  active: rides.some(r => r.status === "PAYMENT_CONFIRMED") },
                { step: "4", title: "Confirm ride",                 desc: "Permit verified — begin journey",              active: activeChannel != null && !activeChannel.settled },
                { step: "5", title: "Receive checkpoints via webhook", desc: "BTC released every 100m",                 active: activeChannel != null && !activeChannel.settled },
                { step: "6", title: "Channel settled",              desc: "Full fare received — update ERC-8004 score",   active: activeChannel?.settled === true },
              ].map(s => (
                <div key={s.step} className={`flex items-start gap-3 p-2 rounded transition-all ${s.active ? "bg-accent/10 border border-accent/30" : "opacity-40"}`}>
                  <span className={`w-5 h-5 rounded-full border font-mono text-[10px] flex items-center justify-center flex-shrink-0 mt-0.5 ${s.active ? "border-accent text-accent" : "border-border text-muted"}`}>{s.step}</span>
                  <div>
                    <p className="text-[12px] font-medium">{s.title}</p>
                    <p className="text-[11px] text-muted">{s.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Earnings ledger */}
          {channels.length > 0 && (
            <div className="bg-card/80 backdrop-blur-sm border border-white/5 rounded-2xl p-5 shadow-2xl shadow-black/40 transition-all hover:border-white/10 fade-up">
              <p className="font-mono text-[11px] text-muted uppercase tracking-widest mb-4">Earnings Ledger</p>
              <div className="space-y-2">
                {channels.slice().reverse().map(c => (
                  <div key={c.channelId} className="flex items-center gap-2.5 py-2 border-b border-border last:border-0">
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.settled ? "bg-accent" : "bg-warn pulse"}`} />
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-[10px] text-muted truncate">{c.channelId.slice(0, 20)}...</p>
                      <p className="text-[11px] text-muted">{c.checkpointsDone}/{c.checkpointsTotal} checkpoints</p>
                    </div>
                    <div className="text-right">
                      <p className={`font-mono text-[12px] coin ${c.settled ? "text-accent" : "text-warn"}`}>
                        +{c.totalReceived.toFixed(4)} BTC
                      </p>
                      <p className="font-mono text-[10px] text-muted">{c.settled ? "settled" : "streaming"}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 pt-3 border-t border-border flex justify-between">
                <span className="text-sm text-muted">Total earned</span>
                <span className="font-mono text-sm text-accent font-bold">{totalEarned.toFixed(4)} BTC</span>
              </div>
            </div>
          )}

          {/* Log terminal */}
          <div className="bg-card/80 backdrop-blur-sm border border-white/5 rounded-2xl p-0 overflow-hidden shadow-2xl shadow-black/40 transition-all hover:border-white/10 mt-4">
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/5 bg-black/20">
              <div className="flex gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-danger/80"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-warn/80"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-accent/80"></span>
              </div>
              <p className="font-mono text-[10px] text-muted tracking-widest">AGENT LOGS</p>
              <button onClick={() => setLogs([])} className="font-mono text-[10px] text-muted hover:text-white transition-colors cursor-pointer">clear</button>
            </div>
            <div className="bg-black/60 p-4 h-64 overflow-y-auto font-mono text-[11px] space-y-1.5">
              {logs.map((l, i) => (
                <div key={i} className="flex gap-2 slide-in">
                  <span className="text-muted flex-shrink-0">{l.time}</span>
                  <span className={`flex-shrink-0 px-1 rounded text-[10px] ${
                    l.tag === "DRIVER" ? "text-accent bg-accent/10" :
                    l.tag === "RIDER"  ? "text-blue   bg-blue/10"  :
                    l.tag === "x402"   ? "text-warn   bg-warn/10"  :
                                         "text-muted  bg-border/50"
                  }`}>{l.tag}</span>
                  <span className={
                    l.type === "ok"   ? "text-accent" :
                    l.type === "warn" ? "text-warn"   :
                    l.type === "err"  ? "text-danger"  : "text-text"
                  }>{l.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
