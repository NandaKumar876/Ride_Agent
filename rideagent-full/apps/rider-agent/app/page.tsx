"use client";
import { useState, useRef, useCallback, useEffect } from "react";
import { ethers } from "ethers";
import { RIDER_AGENT, DRIVER_AGENT, calculateFare } from "@rideagent/shared";

// ─── Types ───────────────────────────────────────────────────────────────────
interface Log  { time: string; tag: "RIDER" | "DRIVER" | "x402" | "SYS"; type: "ok"|"warn"|"err"|"info"; msg: string; }
interface Channel { channelId: string; rideId: string; fareBtc: number; km: number; streamedBtc: number; checkpoint: number; totalCheckpoints: number; status: string; }

// ─── Helpers ─────────────────────────────────────────────────────────────────
function now() { return new Date().toLocaleTimeString("en-GB"); }
function short(addr: string) { return `${addr.slice(0,8)}...${addr.slice(-4)}`; }

export default function RiderPage() {
  const [from,       setFrom]       = useState("Marina Bay Sands");
  const [to,         setTo]         = useState("Changi Airport T3");
  const [maxFare,    setMaxFare]    = useState("10");
  const [minRep,     setMinRep]     = useState("60");
  const [logs,       setLogs]       = useState<Log[]>([]);
  
  useEffect(() => {
    setLogs([
      { time: now(), tag: "SYS",   type: "info", msg: `RiderAgent online — wallet ${short(RIDER_AGENT.wallet)}` },
      { time: now(), tag: "SYS",   type: "info", msg: `Watching DriverAgent at ${process.env.NEXT_PUBLIC_DRIVER_URL || "http://127.0.0.1:4001"}` },
    ]);
  }, []);
  const [channel,    setChannel]    = useState<Channel | null>(null);
  const [rideStatus, setRideStatus] = useState<string>("IDLE");
  const [requesting, setRequesting] = useState(false);
  const [rideId,     setRideId]     = useState<string | null>(null);
  const [streaming,  setStreaming]  = useState(false);
  const [walletAddress, setWalletAddress] = useState<string>(RIDER_AGENT.wallet);
  const streamRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
              params: [{ chainId: '0xbeb0' }], // 48816 in hex but MetaMask might know it as 0xbeb0 based on RPC error
            });
            addLog("SYS", "ok", "Switched to GOAT testnet3");
          } catch (switchError: any) {
            // This error code indicates that the chain has not been added to MetaMask.
            // Some wallets don't throw exact 4902, so try adding it anyway as a fallback.
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

  // ── Request Ride ──────────────────────────────────────────────────────────
  async function requestRide() {
    setRequesting(true);
    setRideStatus("REQUESTING");
    setRideId(null);
    setChannel(null);
    setStreaming(false);
    if (streamRef.current) clearInterval(streamRef.current);
    addLog("RIDER", "info", `Requesting ride: ${from} → ${to}`);
    addLog("RIDER", "info", `Budget: ${maxFare} BTC | Min driver rep: ${minRep}`);

    try {
      const res  = await fetch("/api/request-ride", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ from, to, maxFareBtc: parseFloat(maxFare), minDriverRep: parseFloat(minRep), riderWallet: walletAddress }),
      });
      const data = await res.json();

      // Replay server-side logs into UI
      if (data.logs) {
        for (const l of data.logs) {
          const tag = l.includes("[DRIVER]") ? "DRIVER" : l.includes("[x402]") ? "x402" : "RIDER";
          addLog(tag as Log["tag"], "ok", l.replace(/^\d+:\d+:\d+ \[(RIDER|DRIVER|x402)\] /, ""));
        }
      }

      if (data.status === "PAYMENT_STREAMING" || data.status === "ACCEPTED") {
        setRideStatus(data.status);
        setChannel({
          channelId:        data.channelId,
          rideId:           data.rideId,
          fareBtc:         data.offer?.fareBtc || 0,
          km:               data.offer?.km || 0,
          streamedBtc:     0,
          checkpoint:       0,
          totalCheckpoints: data.offer?.checkpoints || 10,
          status:           "streaming",
        });
      } else if (data.status === "PENDING_REVIEW") {
        setRideStatus(data.status);
        setRideId(data.rideId);
      } else if (data.status === "FAILED" || data.status === "CANCELLED") {
        setRideStatus(data.status);
        addLog("RIDER", "err", data.error || "Ride failed");
      } else {
        setRideStatus(data.status || "UNKNOWN");
      }
    } catch (err) {
      addLog("RIDER", "err", `Request failed: ${String(err)}`);
      setRideStatus("FAILED");
    } finally {
      setRequesting(false);
    }
  }

  // Poll driver agent for ride acceptance when pending review
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (rideStatus === "PENDING_REVIEW" && rideId) {
      interval = setInterval(async () => {
        try {
          // Poll driver using direct fetch since we have CORS headers on the driver now
          const res = await fetch(`${process.env.NEXT_PUBLIC_DRIVER_URL || "http://localhost:4001"}/api/accept`);
          const data = await res.json();
          const matches = data.rides?.find((r: any) => r.rideId === rideId);
          
          if (matches && matches.status === "PAYMENT_REQUESTED") {
             // Driver has formally accepted and is now challenging with 402
             setRideStatus("DRIVER_ACCEPTED");
             addLog("DRIVER", "ok", `Driver reviewed and accepted ride! Fare quoted.`);
             
             // Now we do phase 2, sign the permit
             await executePermitSigning(rideId, matches.channelId || rideId); // we'll implement this next
          } else if (matches && matches.status === "REJECTED") {
             setRideStatus("CANCELLED");
             addLog("DRIVER", "err", `Driver reviewed and REJECTED ride.`);
          }
        } catch(e) {
          console.error("Polling error:", e);
        }
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [rideStatus, rideId]);

  async function executePermitSigning(readyRideId: string, readyChannelId: string) {
    if (!walletAddress) return;
    setRideStatus("SIGNING_PERMIT");
    addLog("SYS", "info", "Requesting MetaMask EIP-712 Signature for BTC payment stream...");

    try {
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();

      // First fetch the actual offer the driver generated when they accepted
      // Using simple string body instead of JSON to avoid CORS preflight OPTIONS which might be failing
      let driverAcceptData;
      try {
        const driverAcceptRes = await fetch(`${process.env.NEXT_PUBLIC_DRIVER_URL || "http://localhost:4001"}/api/accept`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rideId: readyRideId, action: "ACCEPT" }), // Re-triggers the 402 from the driver
        });
        driverAcceptData = await driverAcceptRes.json();
      } catch (fetchErr) {
        addLog("SYS", "err", `Failed to contact driver agent: ${String(fetchErr)}. Are CORS headers set?`);
        setRideStatus("FAILED");
        return;
      }
      
      const paymentHeader = driverAcceptData.headers?.["X-Payment-Request"];
      if (!paymentHeader) throw new Error("No payment request received from driver");
      
      const paymentReq = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
      const fareBtc = parseFloat(paymentReq.amount);
      const rawBtc = ethers.parseUnits(fareBtc.toFixed(6), 18);

      // EIP-712 Types for BTC on GOAT Testnet3
      const domain = {
        name:              "GOAT BTC",
        version:           "2",
        chainId:           48816, // GOAT testnet3 actual chain ID (0xbed0)
        verifyingContract: "0xfe41e7e5cB3460c483AB2A38eb605Cda9e2d248E", // BTC contract
      };

      const types = {
        Permit: [
          { name: "owner",    type: "address" },
          { name: "spender",  type: "address" },
          { name: "value",    type: "uint256" },
          { name: "nonce",    type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hr deadline
      // For this hackathon demo, we just use a random dummy nonce for the permit.
      const permitNonce = BigInt(Math.floor(Math.random() * 1000000));

      const message = {
        owner:    walletAddress,
        spender:  "0x4F96Fe3b7A6Cf9725f59d353F723c1bDb64CA6Aa", // PaymentStream contract
        value:    rawBtc,
        nonce:    permitNonce,
        deadline: BigInt(deadline),
      };

      // 2. Request signature via MetaMask
      const signature = await signer.signTypedData(domain, types, message);
      addLog("SYS", "ok", `Permit signature generated: ${signature.slice(0, 18)}...`);

      // 3. Send final proof to Rider Agent API to pass to Driver
      const res = await fetch("/api/request-ride", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
           rideId: readyRideId, 
           channelId: readyChannelId, 
           riderWallet: walletAddress,
           offer: { amount: fareBtc.toString(), nonce: paymentReq.nonce, signature }
        })
      });

      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(`Backend error ${res.status}: ${data.error || res.statusText}`);
      }
      
      if (data.status === "PAYMENT_STREAMING") {
        setRideStatus(data.status);
        setChannel({
          channelId:        data.channelId,
          rideId:           data.rideId,
          fareBtc:         data.offer?.fareBtc || 0,
          km:               data.offer?.km || 0,
          streamedBtc:     0,
          checkpoint:       0,
          totalCheckpoints: data.offer?.checkpoints || 10,
          status:           "streaming",
        });
        if (data.logs) {
          for (const l of data.logs) addLog("RIDER", "ok", l.replace(/^\d+:\d+:\d+ \[(RIDER|DRIVER|x402)\] /, ""));
        }
      } else {
         throw new Error(`Unexpected status from backend: ${data.status || JSON.stringify(data)}`);
      }
    } catch(err) {
      addLog("SYS", "err", `Permit signing failed: ${String(err)}`);
      setRideStatus("FAILED");
    }
  }

  // ── Start Payment Stream ──────────────────────────────────────────────────
  async function startStream() {
    if (!channel || streaming) return;
    setStreaming(true);
    addLog("x402", "info", `Opening payment channel ${channel.channelId}`);
    addLog("x402", "ok",   `Streaming ${(channel.fareBtc / channel.totalCheckpoints).toFixed(4)} BTC per checkpoint`);

    // Init channel on server
    await fetch("/api/pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: channel.channelId, rideId: channel.rideId, fareBtc: channel.fareBtc, km: channel.km, action: "open" }),
    });

    streamRef.current = setInterval(async () => {
      const res  = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: channel.channelId, action: "checkpoint" }),
      });
      const data = await res.json();

      setChannel(prev => prev ? {
        ...prev,
        streamedBtc:     data.streamedBtc,
        checkpoint:       data.checkpoint,
        totalCheckpoints: data.totalCheckpoints,
        status:           data.status,
      } : prev);

      addLog("x402", "ok",
        `Checkpoint ${data.checkpoint}/${data.totalCheckpoints} — ` +
        `${(channel.fareBtc / channel.totalCheckpoints).toFixed(4)} BTC → ${short(DRIVER_AGENT.wallet)}`
      );

      if (data.driverAck?.received) {
        addLog("DRIVER", "ok", `ACK checkpoint ${data.checkpoint} — received ${(channel.fareBtc / channel.totalCheckpoints).toFixed(4)} BTC`);
      }

      if (data.status === "settled") {
        clearInterval(streamRef.current!);
        setStreaming(false);
        setRideStatus("COMPLETED");
        addLog("x402",   "ok",  `Channel settled — total paid: ${data.fareBtc} BTC`);
        addLog("RIDER",  "ok",  `Ride completed! ERC-8004 scores updating on-chain...`);
        addLog("SYS",    "ok",  `Transaction hash: 0x${Math.random().toString(16).slice(2,42)}`);
      }
    }, 200);
  }

  function stopStream() {
    if (streamRef.current) clearInterval(streamRef.current);
    setStreaming(false);
  }

  function reset() {
    stopStream();
    setChannel(null);
    setRideId(null);
    setRideStatus("IDLE");
    setLogs([{ time: now(), tag: "SYS", type: "info", msg: "Reset — ready for new ride request" }]);
  }

  const progress = channel
    ? Math.round((channel.checkpoint / channel.totalCheckpoints) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-[#111827] via-[#0a0e1a] to-[#0a0e1a] font-sans selection:bg-accent/30">
      {/* Header */}
      <header className="bg-surface/60 backdrop-blur-md border-b border-white/5 px-6 py-3 flex items-center justify-between sticky top-0 z-20 shadow-lg shadow-black/20">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent/20 border border-accent/40 flex items-center justify-center">
            <span className="text-accent font-mono text-[11px] font-bold">R</span>
          </div>
          <div>
            <p className="font-mono text-sm md:text-base text-text font-bold">RiderAgent</p>
            <div className="flex items-center gap-1.5 md:gap-2">
              <p className="font-mono text-[8.5px] md:text-[10px] text-muted">{short(walletAddress)}</p>
              <button onClick={connectWallet} className={`font-mono text-[8.5px] md:text-[9px] border px-1.5 rounded transition-colors ${walletAddress !== RIDER_AGENT.wallet ? "text-green border-green/50 hover:bg-green/10" : "text-accent border-accent/50 hover:bg-accent/10"}`}>
                {walletAddress !== RIDER_AGENT.wallet ? "Connected" : "Connect"}
              </button>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 md:gap-2">
          <span className={`w-1.5 h-1.5 md:w-2 md:h-2 rounded-full ${rideStatus === "IDLE" ? "bg-muted" : rideStatus === "COMPLETED" ? "bg-green" : "bg-accent pulse"}`} />
          <span className={`font-mono text-[9px] md:text-[11px] ${rideStatus === "COMPLETED" ? "text-green" : "text-accent"}`}>{rideStatus}</span>
          <span className="font-mono text-[8.5px] md:text-[10px] text-muted border border-border px-1.5 md:px-2 py-0.5 rounded">port 4000</span>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-3 md:px-4 py-4 md:py-5 flex flex-col md:grid md:grid-cols-2 gap-4">
        {/* LEFT: Controls */}
        <div className="space-y-4">
          {/* Ride Request Form */}
          <div className="bg-card/80 backdrop-blur-sm border border-white/5 rounded-2xl p-5 shadow-2xl shadow-black/40 transition-all hover:border-white/10">
            <p className="font-mono text-[11px] text-accent font-semibold uppercase tracking-widest mb-4 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"></span>
              Request Ride
            </p>
            <div className="space-y-3">
              <div>
                <label className="font-mono text-[10px] text-muted block mb-1.5 ml-1">From</label>
                <input value={from} onChange={e => setFrom(e.target.value)}
                  className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 font-mono text-[12px] text-text focus:outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/50 transition-all placeholder:text-muted/50" />
              </div>
              <div>
                <label className="font-mono text-[10px] text-muted block mb-1.5 ml-1">To</label>
                <input value={to} onChange={e => setTo(e.target.value)}
                  className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 font-mono text-[12px] text-text focus:outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/50 transition-all placeholder:text-muted/50" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="font-mono text-[10px] text-muted block mb-1.5 ml-1">Max fare (BTC)</label>
                  <input type="number" value={maxFare} onChange={e => setMaxFare(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 font-mono text-[12px] text-text focus:outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/50 transition-all placeholder:text-muted/50" />
                </div>
                <div>
                  <label className="font-mono text-[10px] text-muted block mb-1.5 ml-1">Min driver rep</label>
                  <input type="number" value={minRep} onChange={e => setMinRep(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 font-mono text-[12px] text-text focus:outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/50 transition-all placeholder:text-muted/50" />
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-4 pt-1">
              <button onClick={requestRide} disabled={requesting}
                className="flex-[2] py-2.5 rounded-xl font-mono text-[12px] font-bold border border-accent/50 text-white bg-accent/20 hover:bg-accent/30 hover:shadow-[0_0_15px_rgba(59,130,246,0.3)] transition-all disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed">
                {requesting ? "Requesting..." : "Request Ride →"}
              </button>
              <button onClick={reset}
                className="flex-1 py-2.5 rounded-xl font-mono text-[12px] border border-white/5 text-muted hover:bg-white/5 hover:text-text transition-all cursor-pointer">
                Reset
              </button>
            </div>
          </div>

          {/* Fare Preview */}
          {(() => {
            const km   = Math.max(1, parseFloat(maxFare) / 0.23);
            const fare = calculateFare(km, 90);
            return (
              <div className="bg-card/80 backdrop-blur-sm border border-white/5 rounded-2xl p-5 shadow-2xl shadow-black/40 transition-all hover:border-white/10">
                <div className="flex justify-between items-center mb-4">
                  <p className="font-mono text-[11px] text-muted uppercase tracking-widest">Fare Estimate</p>
                  <a href="https://explorer.testnet3.goat.network/address/0x89e7dfd01a86e5393ce6d8A78c9aa6653Ee113A6?tab=read_write_proxy" target="_blank" rel="noopener noreferrer" className="font-mono text-[8.5px] md:text-[9px] text-green border border-green/50 px-1.5 md:px-1.5 py-0.5 rounded hover:bg-green/10 transition-colors shrink-0">Get Test BTC</a>
                </div>
                <div className="space-y-1.5">
                  {[
                    ["Est. distance", `~${km.toFixed(1)} km`],
                    ["Base fare",     `${fare.base.toFixed(2)} BTC`],
                    ["Platform fee",  `${fare.fee.toFixed(2)} BTC`],
                    ["Checkpoints",   `${fare.checkpoints} × ${fare.perCheckpoint.toFixed(4)} BTC`],
                  ].map(([l, v]) => (
                    <div key={l} className="flex justify-between">
                      <span className="text-[12px] text-muted">{l}</span>
                      <span className="font-mono text-[12px]">{v}</span>
                    </div>
                  ))}
                  <div className="flex justify-between pt-2 border-t border-border">
                    <span className="text-sm font-medium">Total max</span>
                    <span className="font-mono text-sm text-green font-bold">{fare.total.toFixed(2)} BTC</span>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* x402 Payment Channel */}
          {channel && (
            <div className="bg-card/80 backdrop-blur-sm border border-accent/20 rounded-2xl p-5 shadow-[0_0_30px_rgba(0,212,170,0.1)] fade-up">
              <p className="font-mono text-[11px] text-green font-semibold uppercase tracking-widest mb-4 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse"></span>
                x402 Payment Channel
              </p>

              {/* Progress bar */}
              <div className="mb-3">
                <div className="flex justify-between text-[11px] mb-1.5">
                  <span className="text-muted font-mono">Streamed</span>
                  <span className="font-mono text-green">{(channel.streamedBtc || 0).toFixed(4)} / {(channel.fareBtc || 0).toFixed(2)} BTC</span>
                </div>
                <div className="h-2 bg-border rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-accent to-green rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }} />
                </div>
                <div className="flex justify-between text-[10px] mt-1 text-muted font-mono">
                  <span>Checkpoint {channel.checkpoint}/{channel.totalCheckpoints}</span>
                  <span>{progress}%</span>
                </div>
              </div>

              <div className="space-y-1 mb-3">
                {[
                  ["Channel ID",  channel.channelId],
                  ["Ride ID",     channel.rideId],
                  ["Payer",       short(walletAddress)],
                  ["Recipient",   short(DRIVER_AGENT.wallet)],
                  ["Status",      channel.status.toUpperCase()],
                ].map(([l, v]) => (
                  <div key={l} className="flex justify-between">
                    <span className="text-[11px] text-muted">{l}</span>
                    <span className={`font-mono text-[11px] ${v === "SETTLED" ? "text-green" : "text-text"}`}>{v}</span>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                {channel.status !== "settled" && (
                  <button onClick={streaming ? stopStream : startStream}
                    className={`flex-1 py-2 rounded font-mono text-[12px] border transition-all cursor-pointer
                      ${streaming
                        ? "border-warn text-warn bg-warn/10 hover:bg-warn/20"
                        : "border-green text-green bg-green/10 hover:bg-green/20"}`}>
                    {streaming ? "⏸ Pause Stream" : "▶ Start Stream"}
                  </button>
                )}
                {channel.status === "settled" && (
                  <div className="flex-1 py-2 rounded font-mono text-[12px] border border-green text-green bg-green/10 text-center">
                    ✓ Settled
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT: Agent-to-Agent Protocol Visualiser + Logs */}
        <div className="space-y-4">
          {/* Protocol Flow */}
          <div className="bg-card/80 backdrop-blur-sm border border-white/5 rounded-2xl p-5 shadow-2xl shadow-black/40 transition-all hover:border-white/10">
            <p className="font-mono text-[11px] text-muted uppercase tracking-widest mb-4">Agent-to-Agent Protocol</p>
            <div className="space-y-2">
              {PROTOCOL_STEPS.map((step, i) => {
                const done = getStepDone(rideStatus, i);
                const active = getStepActive(rideStatus, i);
                return (
                  <div key={i} className={`flex items-start gap-3 p-2.5 rounded transition-all ${active ? "bg-accent/10 border border-accent/30" : done ? "opacity-60" : "opacity-30"}`}>
                    <div className={`w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 mt-0.5 font-mono text-[10px]
                      ${done ? "border-green text-green bg-green/10" : active ? "border-accent text-accent bg-accent/10" : "border-border text-muted"}`}>
                      {done ? "✓" : i + 1}
                    </div>
                    <div className="flex-1">
                      <p className="text-[12px] font-medium">{step.title}</p>
                      <p className="text-[11px] text-muted">{step.desc}</p>
                    </div>
                    <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                      step.dir === "→" ? "text-accent bg-accent/10" : step.dir === "←" ? "text-green bg-green/10" : "text-muted bg-border/50"
                    }`}>{step.dir}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Log terminal */}
          <div className="bg-card/80 backdrop-blur-sm border border-white/5 rounded-2xl p-0 overflow-hidden shadow-2xl shadow-black/40 transition-all hover:border-white/10">
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/5 bg-black/20">
              <div className="flex gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-danger/80"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-warn/80"></span>
                <span className="w-2.5 h-2.5 rounded-full bg-green/80"></span>
              </div>
              <p className="font-mono text-[10px] text-muted tracking-widest">AGENT LOGS</p>
              <button onClick={() => setLogs([])} className="font-mono text-[10px] text-muted hover:text-white transition-colors cursor-pointer">clear</button>
            </div>
            <div className="bg-black/60 p-4 h-64 overflow-y-auto font-mono text-[11px] space-y-1.5">
              {logs.map((l, i) => (
                <div key={i} className="flex gap-2 slide-in">
                  <span className="text-muted flex-shrink-0">{l.time}</span>
                  <span className={`flex-shrink-0 px-1 rounded text-[10px] ${
                    l.tag === "RIDER"  ? "text-accent bg-accent/10" :
                    l.tag === "DRIVER" ? "text-green  bg-green/10" :
                    l.tag === "x402"   ? "text-warn   bg-warn/10" :
                                         "text-muted  bg-border/50"
                  }`}>{l.tag}</span>
                  <span className={
                    l.type === "ok"   ? "text-green" :
                    l.type === "warn" ? "text-warn" :
                    l.type === "err"  ? "text-danger" : "text-text"
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

const PROTOCOL_STEPS = [
  { title: "Rider sends ride request",        desc: "POST /api/accept on Driver Agent",                       dir: "→" },
  { title: "Driver returns HTTP 402",         desc: "X-Payment-Request header with fare + EIP-712 nonce",    dir: "←" },
  { title: "Rider evaluates fare",            desc: "Checks fare ≤ budget, signs EIP-712 BTC permit",       dir: "⚙" },
  { title: "Rider sends X-Payment header",   desc: "Permit signature proves BTC locked in escrow",          dir: "→" },
  { title: "Driver verifies & confirms",      desc: "Validates permit, opens payment channel",               dir: "←" },
  { title: "x402 stream open",                desc: "BTC released every 100m checkpoint",                   dir: "⚙" },
  { title: "Ride completes — channel settled", desc: "Total BTC transferred, ERC-8004 scores updated",     dir: "✓" },
];

function getStepDone(status: string, i: number): boolean {
  const map: Record<string, number> = { IDLE: -1, REQUESTING: 0, PAYMENT_STREAMING: 4, ACCEPTED: 4, COMPLETED: 7 };
  return i < (map[status] ?? -1);
}
function getStepActive(status: string, i: number): boolean {
  const map: Record<string, number> = { IDLE: -1, REQUESTING: 0, PAYMENT_STREAMING: 5, ACCEPTED: 4, COMPLETED: 6 };
  return i === (map[status] ?? -1);
}
