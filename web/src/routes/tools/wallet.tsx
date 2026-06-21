import { createFileRoute } from '@tanstack/react-router'
import { Button } from '@heroui/react'
import {
  AlertTriangle,
  Check,
  Copy,
  Droplet,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Wallet,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'

import { TextField } from '@/ui/TextField'
import { cnm } from '@/utils/style'
import {
  type CoinRow,
  type NetInfo,
  SUI_DECIMALS,
  SUI_TYPE,
  addressFromPk,
  defaultFaucetUrl,
  fetchBalances,
  formatRaw,
  generatePrivKey,
  isAddress,
  loadFaucetUrl,
  loadPrivKey,
  loadRpcUrl,
  makeClient,
  parseToRaw,
  probe,
  requestFaucet,
  saveFaucetUrl,
  savePrivKey,
  saveRpcUrl,
  sendCoin,
  clearPrivKey,
} from '@/lib/sui/devwallet'

// A throwaway in-browser wallet for the localnet / custom-RPC chain. No wallet extension speaks
// to a private node, so this is the debug surface: see balances, move funds, hit the faucet.
export const Route = createFileRoute('/tools/wallet')({ component: WalletTools })

function WalletTools() {
  // localStorage + keypairs are client only; mount-gate so SSR never touches them.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return (
    <main className="min-h-dvh bg-canvas px-4 py-8 text-text">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
        <Header />
        {mounted ? <Inner /> : <p className="text-sm text-text-2">Loading wallet tools…</p>}
      </div>
    </main>
  )
}

function Header() {
  return (
    <header className="flex items-start gap-3">
      <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-brand-500 text-black">
        <Wallet className="size-5" />
      </div>
      <div>
        <h1 className="text-lg font-semibold leading-tight">Wallet tools</h1>
        <p className="text-sm text-text-2">
          Inspect balances and move funds on the localnet / custom RPC. Debug only.
        </p>
      </div>
    </header>
  )
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-2">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          toast.success(label ?? 'Copied', { id: 'wallet-copy' })
          setTimeout(() => setDone(false), 1200)
        } catch {
          toast.error('Copy failed', { id: 'wallet-copy' })
        }
      }}
      className="inline-grid size-7 shrink-0 place-items-center rounded-lg text-text-2 transition hover:bg-surface-2 hover:text-text"
      aria-label="Copy"
    >
      {done ? <Check className="size-3.5 text-up" /> : <Copy className="size-3.5" />}
    </button>
  )
}

function short(s: string, head = 6, tail = 4): string {
  return s.length > head + tail + 2 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s
}

function Inner() {
  const [rpcUrl, setRpcUrl] = useState(loadRpcUrl)
  const [faucetUrl, setFaucetUrl] = useState(loadFaucetUrl)
  const [pk, setPk] = useState<string | null>(loadPrivKey)
  const [watch, setWatch] = useState('')
  const [showPk, setShowPk] = useState(false)
  const [importInput, setImportInput] = useState('')

  const [net, setNet] = useState<NetInfo | null>(null)
  const [netErr, setNetErr] = useState<string | null>(null)
  const [balances, setBalances] = useState<CoinRow[] | null>(null)
  const [balErr, setBalErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // send form
  const [sendType, setSendType] = useState(SUI_TYPE)
  const [sendTo, setSendTo] = useState('')
  const [sendAmt, setSendAmt] = useState('')
  const [sending, setSending] = useState(false)

  const client = useMemo(() => makeClient(rpcUrl), [rpcUrl])

  // The active address: the loaded key's, or a watch-only address.
  const address = useMemo(() => {
    if (pk) {
      try {
        return addressFromPk(pk)
      } catch {
        return null
      }
    }
    return isAddress(watch) ? watch.trim() : null
  }, [pk, watch])

  const refreshNet = useCallback(async () => {
    setNetErr(null)
    try {
      setNet(await probe(client))
    } catch (e) {
      setNet(null)
      setNetErr(errMsg(e))
    }
  }, [client])

  const refreshBalances = useCallback(async () => {
    if (!address) {
      setBalances(null)
      return
    }
    setBalErr(null)
    try {
      setBalances(await fetchBalances(client, address))
    } catch (e) {
      setBalances(null)
      setBalErr(errMsg(e))
    }
  }, [client, address])

  useEffect(() => {
    void refreshNet()
  }, [refreshNet])
  useEffect(() => {
    void refreshBalances()
  }, [refreshBalances])

  // Keep the send coin selector valid as balances change.
  useEffect(() => {
    if (balances && !balances.some((b) => b.coinType === sendType)) setSendType(SUI_TYPE)
  }, [balances, sendType])

  const applyRpc = (url: string) => {
    const u = url.trim()
    setRpcUrl(u)
    saveRpcUrl(u)
  }
  const applyFaucet = (url: string) => {
    setFaucetUrl(url)
    saveFaucetUrl(url)
  }

  const onGenerate = () => {
    const key = generatePrivKey()
    savePrivKey(key)
    setPk(key)
    setShowPk(true)
    toast.success('New key generated. Fund it from the faucet below.', { id: 'wallet-key' })
  }
  const onImport = () => {
    const v = importInput.trim()
    try {
      addressFromPk(v) // validates
      savePrivKey(v)
      setPk(v)
      setImportInput('')
      toast.success('Key imported', { id: 'wallet-key' })
    } catch {
      toast.error('Not a valid suiprivkey key', { id: 'wallet-key' })
    }
  }
  const onClear = () => {
    clearPrivKey()
    setPk(null)
    setShowPk(false)
    toast.success('Key removed from this browser', { id: 'wallet-key' })
  }

  const selected = balances?.find((b) => b.coinType === sendType)
  const sendDecimals = sendType === SUI_TYPE ? SUI_DECIMALS : (selected?.decimals ?? 0)

  const onSend = async () => {
    if (!pk) return toast.error('Load a key to send (watch-only address cannot sign)', { id: 'wallet-send' })
    if (!isAddress(sendTo)) return toast.error('Enter a valid recipient address', { id: 'wallet-send' })
    let amountRaw: bigint
    try {
      amountRaw = parseToRaw(sendAmt, sendDecimals)
    } catch (e) {
      return toast.error(errMsg(e), { id: 'wallet-send' })
    }
    if (amountRaw <= 0n) return toast.error('Amount must be greater than zero', { id: 'wallet-send' })
    setSending(true)
    try {
      const digest = await sendCoin({ client, pk, coinType: sendType, recipient: sendTo.trim(), amountRaw })
      toast.success(`Sent. ${short(digest, 8, 6)}`, { id: 'wallet-send' })
      setSendAmt('')
      await refreshBalances()
    } catch (e) {
      toast.error(errMsg(e), { id: 'wallet-send' })
    } finally {
      setSending(false)
    }
  }

  const onFaucet = async () => {
    if (!address) return toast.error('Load or watch an address first', { id: 'wallet-faucet' })
    setBusy(true)
    try {
      await requestFaucet(faucetUrl, address)
      toast.success('Faucet request sent. Refreshing…', { id: 'wallet-faucet' })
      setTimeout(() => void refreshBalances(), 1500)
    } catch (e) {
      toast.error(errMsg(e), { id: 'wallet-faucet' })
    } finally {
      setBusy(false)
    }
  }

  const httpsSelfSigned = rpcUrl.startsWith('https://') && netErr != null

  return (
    <>
      {/* Network */}
      <Panel
        title="Network"
        action={
          <button
            type="button"
            onClick={() => void refreshNet()}
            className="inline-grid size-7 place-items-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text"
            aria-label="Reconnect"
          >
            <RefreshCw className="size-3.5" />
          </button>
        }
      >
        <TextField
          label="RPC URL"
          value={rpcUrl}
          onChange={applyRpc}
          placeholder="https://fullnode.devnet.sui.io:443"
          type="url"
        />
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          {net ? (
            <>
              <Stat label="chain" value={net.chainId} />
              <Stat label="gas price" value={net.gasPrice} />
              <span className="inline-flex items-center gap-1.5 text-up">
                <span className="size-1.5 rounded-full bg-up" /> connected
              </span>
            </>
          ) : netErr ? (
            <span className="text-down">{netErr}</span>
          ) : (
            <span className="text-text-2">connecting…</span>
          )}
        </div>
        {httpsSelfSigned && (
          <Note>
            Can't reach an HTTPS node? A localnet behind Traefik often serves a self-signed cert the
            browser rejects. Open the RPC URL in a new tab and accept the cert once, or give the node
            a real TLS cert. You can also point this at a tunnelled <code>http://127.0.0.1:9000</code>.
          </Note>
        )}
      </Panel>

      {/* Account */}
      <Panel title="Account">
        {address ? (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm">
              {address}
            </code>
            <CopyBtn text={address} label="Address copied" />
          </div>
        ) : (
          <p className="text-sm text-text-2">No key or address loaded yet.</p>
        )}

        {pk ? (
          <>
            <div className="mt-3 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-text-2">
                {showPk ? pk : '•'.repeat(40)}
              </code>
              <button
                type="button"
                onClick={() => setShowPk((s) => !s)}
                className="inline-grid size-7 place-items-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text"
                aria-label={showPk ? 'Hide key' : 'Reveal key'}
              >
                {showPk ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
              <CopyBtn text={pk} label="Private key copied" />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="tertiary" onPress={onGenerate}>
                <Plus className="size-4" /> New key
              </Button>
              <Button size="sm" variant="danger" onPress={onClear}>
                <Trash2 className="size-4" /> Remove key
              </Button>
            </div>
          </>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <TextField
                  label="Import key"
                  value={importInput}
                  onChange={setImportInput}
                  placeholder="suiprivkey1…"
                  type="password"
                />
              </div>
              <Button size="sm" variant="secondary" onPress={onImport} isDisabled={!importInput.trim()}>
                Import
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <TextField
                  label="Watch address (read only)"
                  value={watch}
                  onChange={setWatch}
                  placeholder="0x…"
                />
              </div>
              <Button size="sm" variant="tertiary" onPress={onGenerate}>
                <Plus className="size-4" /> New key
              </Button>
            </div>
          </div>
        )}
      </Panel>

      {/* Balances */}
      <Panel
        title="Balances"
        action={
          <button
            type="button"
            onClick={() => void refreshBalances()}
            className="inline-grid size-7 place-items-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text"
            aria-label="Refresh balances"
          >
            <RefreshCw className="size-3.5" />
          </button>
        }
      >
        {!address ? (
          <p className="text-sm text-text-2">Load a key or watch an address to see balances.</p>
        ) : balErr ? (
          <p className="text-sm text-down">{balErr}</p>
        ) : !balances ? (
          <p className="text-sm text-text-2">loading…</p>
        ) : balances.length === 0 ? (
          <p className="text-sm text-text-2">No coins. Use the faucet to fund this address.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {balances.map((b) => (
              <li key={b.coinType} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="font-medium">{b.symbol}</div>
                  <div className="truncate font-mono text-xs text-text-3">{short(b.coinType, 10, 8)}</div>
                </div>
                <div className="font-mono text-sm tabular-nums">{formatRaw(b.raw, b.decimals)}</div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Send */}
      <Panel title="Send funds">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-text-2">Coin</span>
            <select
              value={sendType}
              onChange={(e) => setSendType(e.target.value)}
              className="rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-text outline-none focus:border-line-strong"
            >
              {(balances && balances.length > 0 ? balances : [{ coinType: SUI_TYPE, symbol: 'SUI' } as CoinRow]).map(
                (b) => (
                  <option key={b.coinType} value={b.coinType}>
                    {b.symbol}
                  </option>
                ),
              )}
            </select>
          </label>
          <TextField label="Recipient" value={sendTo} onChange={setSendTo} placeholder="0x…" />
          <TextField
            label={`Amount${selected ? ` (have ${formatRaw(selected.raw, selected.decimals)})` : ''}`}
            value={sendAmt}
            onChange={setSendAmt}
            placeholder="0.0"
            type="text"
          />
          <Button
            variant="primary"
            onPress={onSend}
            isDisabled={sending || !pk}
            className={cnm(!pk && 'opacity-60')}
          >
            <Send className="size-4" /> {sending ? 'Sending…' : 'Send'}
          </Button>
          {!pk && <p className="text-xs text-text-3">Load a key above to send. Watch-only addresses can't sign.</p>}
        </div>
      </Panel>

      {/* Faucet */}
      <Panel title="Faucet">
        <div className="flex flex-col gap-3">
          <TextField
            label="Faucet URL"
            value={faucetUrl}
            onChange={applyFaucet}
            placeholder={defaultFaucetUrl()}
            type="url"
          />
          <Button variant="secondary" onPress={onFaucet} isDisabled={busy || !address}>
            <Droplet className="size-4" /> {busy ? 'Requesting…' : 'Request SUI'}
          </Button>
          <p className="text-xs text-text-3">
            Drips gas SUI to the active address. Needs the node started with a faucet
            (<code>sui start --with-faucet</code>) reachable at this URL.
          </p>
        </div>
      </Panel>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-text-3">{label}</span>
      <code className="font-mono text-text">{value}</code>
    </span>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex gap-2 rounded-xl border border-brand-500/30 bg-brand-500/10 p-3 text-xs leading-relaxed text-brand-300">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  )
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
