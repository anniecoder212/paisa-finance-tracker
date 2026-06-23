import { useState } from 'react'
import * as XLSX from 'xlsx'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import './App.css'

const CATEGORIES = ['Needs', 'Wants', 'Rent', 'Investments']
const CAT_COLORS = { Needs: '#1D9E75', Wants: '#7F77DD', Rent: '#D85A30', Investments: '#378ADD' }
const CAT_BG = { Needs: '#E1F5EE', Wants: '#EEEDFE', Rent: '#FAECE7', Investments: '#E6F1FB' }
const CAT_EMOJI = { Needs: '🏥', Wants: '🛍️', Rent: '🏠', Investments: '📈' }
const MODES = ['UPI', 'Cash', 'Card', 'Net banking']

function fmt(n) {
  return '₹' + Math.round(n).toLocaleString('en-IN')
}

function parseDate(val) {
  if (!val) return ''
  if (typeof val === 'number') {
    const d = new Date(Math.round((val - 25569) * 86400 * 1000))
    return d.toISOString().slice(0, 10)
  }
  return String(val).slice(0, 10)
}

export default function App() {
  const [tab, setTab] = useState('upload')
  const [transactions, setTransactions] = useState(() => JSON.parse(localStorage.getItem('paisa_txns') || '[]'))
  const [budgets, setBudgets] = useState(() => JSON.parse(localStorage.getItem('paisa_budgets') || '{}'))
  const [loading, setLoading] = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const [manualForm, setManualForm] = useState({ desc: '', amount: '', cat: 'Needs', mode: 'UPI', date: new Date().toISOString().slice(0, 10) })
  const [budgetInputs, setBudgetInputs] = useState(budgets)
  const [addedMsg, setAddedMsg] = useState(false)
  const [screenshotDrag, setScreenshotDrag] = useState(false)

  function saveTxns(txns) {
    setTransactions(txns)
    localStorage.setItem('paisa_txns', JSON.stringify(txns))
  }

  // Convert image file to base64
  async function fileToBase64(file) {
    return new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result.split(',')[1])
      r.onerror = () => rej(new Error('Read failed'))
      r.readAsDataURL(file)
    })
  }

  // Extract transactions from screenshot using Claude vision
  async function extractFromScreenshot(file) {
    setLoading(true)
    setLoadingMsg('Reading your screenshot…')
    setUploadMsg('')
    try {
      const base64 = await fileToBase64(file)
      const mediaType = file.type || 'image/png'

      setLoadingMsg('Claude is extracting transactions…')

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 }
              },
              {
                type: 'text',
                text: `This is a screenshot of a payment app transaction history (like Google Pay, PhonePe, Paytm, or a bank statement).

Extract ALL transactions you can see. For each transaction identify:
1. date (YYYY-MM-DD format, use current year if not shown)
2. description (merchant name or transaction description)
3. amount (number only, in rupees, only outgoing/debit amounts)
4. category - classify into exactly one of: Needs, Wants, Rent, Investments

Category rules:
- Needs: groceries, pharmacy, hospital, utilities, fuel, school fees, essential food
- Wants: restaurants, Zomato, Swiggy, shopping, Netflix, entertainment, salon, travel, clothes, food delivery
- Rent: rent, EMI, housing loan, PG, society maintenance
- Investments: Zerodha, mutual fund, SIP, stocks, Groww, gold, FD, insurance premium

Reply ONLY with a valid JSON array, no other text:
[{"date":"2025-01-15","description":"Zomato","amount":450,"category":"Wants"},...]

If you cannot find any transactions, return an empty array: []`
              }
            ]
          }]
        })
      })

      const data = await res.json()
      const text = data.content?.map(c => c.text || '').join('') || '[]'

      setLoadingMsg('Processing results…')

      let parsed = []
      try {
        const clean = text.replace(/```json|```/g, '').trim()
        parsed = JSON.parse(clean)
      } catch {
        setUploadMsg('Could not read transactions from screenshot. Try a clearer image.')
        setLoading(false)
        return
      }

      if (!parsed.length) {
        setUploadMsg('No transactions found in screenshot. Make sure the image shows transaction amounts and names clearly.')
        setLoading(false)
        return
      }

      const newTxns = parsed.map((r, i) => ({
        id: Date.now() + i,
        date: r.date || new Date().toISOString().slice(0, 10),
        description: r.description || 'Unknown',
        amount: parseFloat(r.amount) || 0,
        cat: r.category || 'Wants',
        mode: 'UPI'
      })).filter(t => t.amount > 0)

      saveTxns([...newTxns, ...transactions])
      setUploadMsg(`✓ Extracted ${newTxns.length} transactions from screenshot`)
      setTab('dashboard')
    } catch (e) {
      setUploadMsg('Error processing screenshot. Please try again.')
    }
    setLoading(false)
    setLoadingMsg('')
  }

  async function categorizeWithClaude(rows) {
    const prompt = `You are a personal finance categorizer for Indian users. Categorize each transaction into exactly one of: Needs, Wants, Rent, Investments.

Rules:
- Needs: groceries, pharmacy, hospital, utilities, fuel, school fees, essential food
- Wants: restaurants, Zomato, Swiggy, shopping, Netflix, entertainment, salon, travel, clothes
- Rent: rent, EMI, housing loan, PG, society maintenance
- Investments: Zerodha, mutual fund, SIP, stocks, Groww, gold, FD, insurance premium

Transactions:
${rows.map((r, i) => `${i + 1}. "${r.description}" Rs.${r.amount}`).join('\n')}

Reply ONLY with a JSON array of category strings in the same order. Example: ["Needs","Wants","Rent"]`

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    })
    const data = await res.json()
    const text = data.content?.map(c => c.text || '').join('') || '[]'
    try {
      const clean = text.replace(/```json|```/g, '').trim()
      return JSON.parse(clean)
    } catch {
      return rows.map(() => 'Wants')
    }
  }

  async function processExcel(file) {
    setLoading(true)
    setLoadingMsg('Reading Excel file…')
    setUploadMsg('')
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf)
      const ws = wb.Sheets[wb.SheetNames[0]]
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1 })
      const header = raw[0]?.map(h => String(h || '').toLowerCase())
      const dateIdx = header?.findIndex(h => h.includes('date'))
      const descIdx = header?.findIndex(h => h.includes('desc') || h.includes('note') || h.includes('narr') || h.includes('particular'))
      const amtIdx = header?.findIndex(h => h.includes('amount') || h.includes('debit') || h.includes('amt'))

      if (dateIdx === -1 || descIdx === -1 || amtIdx === -1) {
        setUploadMsg('Could not find Date, Description, Amount columns. Check your Excel format.')
        setLoading(false)
        return
      }

      const rows = raw.slice(1)
        .filter(r => r[amtIdx] && parseFloat(r[amtIdx]) > 0)
        .map(r => ({
          date: parseDate(r[dateIdx]),
          description: String(r[descIdx] || '').trim(),
          amount: parseFloat(r[amtIdx]) || 0
        }))
        .filter(r => r.description && r.amount > 0)

      if (!rows.length) {
        setUploadMsg('No valid transactions found. Check your file.')
        setLoading(false)
        return
      }

      setLoadingMsg('Claude is categorizing transactions…')
      const cats = await categorizeWithClaude(rows)
      const newTxns = rows.map((r, i) => ({
        id: Date.now() + i,
        date: r.date,
        description: r.description,
        amount: r.amount,
        cat: cats[i] || 'Wants',
        mode: 'UPI'
      }))

      saveTxns([...newTxns, ...transactions])
      setUploadMsg(`✓ Imported ${newTxns.length} transactions`)
      setTab('dashboard')
    } catch (e) {
      setUploadMsg('Error reading file. Make sure it is a valid .xlsx file.')
    }
    setLoading(false)
    setLoadingMsg('')
  }

  function handleFile(file) {
    if (!file) return
    if (file.type.startsWith('image/')) {
      extractFromScreenshot(file)
    } else {
      processExcel(file)
    }
  }

  function onDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer?.files[0] || e.target.files?.[0]
    handleFile(file)
  }

  function addManual() {
    if (!manualForm.amount || parseFloat(manualForm.amount) <= 0) return
    saveTxns([{
      id: Date.now(),
      date: manualForm.date,
      description: manualForm.desc || manualForm.cat,
      amount: parseFloat(manualForm.amount),
      cat: manualForm.cat,
      mode: manualForm.mode
    }, ...transactions])
    setManualForm(f => ({ ...f, desc: '', amount: '' }))
    setAddedMsg(true)
    setTimeout(() => setAddedMsg(false), 1500)
  }

  function deleteTxn(id) { saveTxns(transactions.filter(t => t.id !== id)) }
  function updateCat(id, cat) { saveTxns(transactions.map(t => t.id === id ? { ...t, cat } : t)) }
  function saveBudgets() {
    setBudgets(budgetInputs)
    localStorage.setItem('paisa_budgets', JSON.stringify(budgetInputs))
  }

  const totalExpense = transactions.reduce((s, t) => s + t.amount, 0)
  const catTotals = CATEGORIES.reduce((acc, c) => {
    acc[c] = transactions.filter(t => t.cat === c).reduce((s, t) => s + t.amount, 0)
    return acc
  }, {})
  const pieData = CATEGORIES.filter(c => catTotals[c] > 0).map(c => ({ name: c, value: Math.round(catTotals[c]) }))

  return (
    <div className="app">
      <header className="header">
        <div className="logo">paisa<span className="dot">.</span></div>
        <nav className="nav">
          {[['upload', 'Import'], ['dashboard', 'Dashboard'], ['transactions', 'Transactions'], ['budget', 'Budget']].map(([id, label]) => (
            <button key={id} className={'nav-btn' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
      </header>

      <main className="main">

        {tab === 'upload' && (
          <div className="section">
            <h1 className="page-title">Import transactions</h1>
            <p className="page-sub">Upload a screenshot of your GPay history — Claude reads it and categorizes everything instantly.</p>

            {/* Screenshot upload - primary */}
            <div
              className={'dropzone screenshot-zone' + (screenshotDrag ? ' drag-over' : '')}
              onDragOver={e => { e.preventDefault(); setScreenshotDrag(true) }}
              onDragLeave={() => setScreenshotDrag(false)}
              onDrop={e => { e.preventDefault(); setScreenshotDrag(false); handleFile(e.dataTransfer?.files[0]) }}
              onClick={() => document.getElementById('screenshot-in').click()}
            >
              {loading ? (
                <div className="loading-wrap">
                  <div className="spinner"></div>
                  <div className="loading-text">{loadingMsg}</div>
                </div>
              ) : (
                <>
                  <div className="drop-icon">📸</div>
                  <div className="drop-text">Upload GPay / PhonePe screenshot</div>
                  <div className="drop-sub">Claude will extract and categorize all transactions automatically</div>
                  <div className="upload-btn">Choose screenshot</div>
                </>
              )}
              <input id="screenshot-in" type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
            </div>

            {uploadMsg && <div className={'upload-msg ' + (uploadMsg.startsWith('✓') ? 'success' : 'error')}>{uploadMsg}</div>}

            <div className="divider"><span>or upload Excel</span></div>

            {/* Excel upload - secondary */}
            <div
              className={'dropzone excel-zone' + (dragOver ? ' drag-over' : '')}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer?.files[0]) }}
              onClick={() => document.getElementById('excel-in').click()}
            >
              <div className="drop-icon-sm">📊</div>
              <div className="drop-text-sm">Upload .xlsx bank statement</div>
              <div className="drop-sub">Needs columns: Date, Description, Amount</div>
              <input id="excel-in" type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
            </div>

            <div className="divider"><span>or add manually</span></div>

            <div className="card">
              <div className="form-row">
                <div className="field"><label>Description</label><input value={manualForm.desc} onChange={e => setManualForm(f => ({ ...f, desc: e.target.value }))} placeholder="e.g. Zomato order" /></div>
                <div className="field"><label>Amount (₹)</label><input type="number" value={manualForm.amount} onChange={e => setManualForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" min="0" /></div>
              </div>
              <div className="form-row three">
                <div className="field"><label>Category</label><select value={manualForm.cat} onChange={e => setManualForm(f => ({ ...f, cat: e.target.value }))}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></div>
                <div className="field"><label>Mode</label><select value={manualForm.mode} onChange={e => setManualForm(f => ({ ...f, mode: e.target.value }))}>{MODES.map(m => <option key={m}>{m}</option>)}</select></div>
                <div className="field"><label>Date</label><input type="date" value={manualForm.date} onChange={e => setManualForm(f => ({ ...f, date: e.target.value }))} /></div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <button className="btn-primary" onClick={addManual}>Add transaction</button>
                {addedMsg && <span className="added-msg">Added!</span>}
              </div>
            </div>
          </div>
        )}

        {tab === 'dashboard' && (
          <div className="section">
            <h1 className="page-title">Dashboard</h1>
            {transactions.length === 0 ? (
              <div className="empty-state">No transactions yet. <button className="link-btn" onClick={() => setTab('upload')}>Import or add some →</button></div>
            ) : (
              <>
                <div className="metrics">
                  <div className="metric total-metric">
                    <div className="metric-label">Total spent</div>
                    <div className="metric-value total">{fmt(totalExpense)}</div>
                  </div>
                  {CATEGORIES.map(c => (
                    <div className="metric" key={c} style={{ borderTop: `3px solid ${CAT_COLORS[c]}` }}>
                      <div className="metric-label">{CAT_EMOJI[c]} {c}</div>
                      <div className="metric-value" style={{ color: CAT_COLORS[c] }}>{fmt(catTotals[c])}</div>
                      <div className="metric-pct">{totalExpense > 0 ? Math.round((catTotals[c] / totalExpense) * 100) : 0}% of total</div>
                    </div>
                  ))}
                </div>

                <div className="card">
                  <div class="card-title">Spending breakdown</div>
                  <div className="chart-row">
                    <ResponsiveContainer width="55%" height={200}>
                      <PieChart>
                        <Pie data={pieData} cx="50%" cy="50%" innerRadius={55} outerRadius={90} dataKey="value" paddingAngle={2}>
                          {pieData.map(entry => <Cell key={entry.name} fill={CAT_COLORS[entry.name]} />)}
                        </Pie>
                        <Tooltip formatter={v => fmt(v)} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="legend">
                      {CATEGORIES.filter(c => catTotals[c] > 0).map(c => (
                        <div className="legend-item" key={c}>
                          <span className="legend-dot" style={{ background: CAT_COLORS[c] }}></span>
                          <span className="legend-name">{CAT_EMOJI[c]} {c}</span>
                          <span className="legend-val">{fmt(catTotals[c])}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {Object.keys(budgets).length > 0 && (
                  <div className="card">
                    <div className="card-title">Budget usage</div>
                    {CATEGORIES.filter(c => budgets[c]).map(c => {
                      const pct = Math.min(100, Math.round((catTotals[c] / budgets[c]) * 100))
                      const color = pct >= 90 ? '#E24B4A' : pct >= 70 ? '#BA7517' : CAT_COLORS[c]
                      return (
                        <div className="budget-row" key={c}>
                          <div className="budget-lbl">{CAT_EMOJI[c]} {c}</div>
                          <div className="progress-track"><div className="progress-fill" style={{ width: pct + '%', background: color }}></div></div>
                          <div className="budget-nums">{fmt(catTotals[c])} / {fmt(budgets[c])}</div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'transactions' && (
          <div className="section">
            <h1 className="page-title">Transactions <span className="count-badge">{transactions.length}</span></h1>
            {transactions.length === 0 ? (
              <div className="empty-state">No transactions. <button className="link-btn" onClick={() => setTab('upload')}>Import some →</button></div>
            ) : (
              <div className="txn-list">
                {transactions.map(t => (
                  <div className="txn" key={t.id}>
                    <div className="txn-icon" style={{ background: CAT_BG[t.cat] }}>{CAT_EMOJI[t.cat]}</div>
                    <div className="txn-info">
                      <div className="txn-desc">{t.description}</div>
                      <div className="txn-meta">{t.date} · {t.mode}</div>
                    </div>
                    <select className="cat-select" value={t.cat} onChange={e => updateCat(t.id, e.target.value)} style={{ color: CAT_COLORS[t.cat] }}>
                      {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                    <div className="txn-amount">{fmt(t.amount)}</div>
                    <button className="del-btn" onClick={() => deleteTxn(t.id)}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'budget' && (
          <div className="section">
            <h1 className="page-title">Monthly budgets</h1>
            <p className="page-sub">Set a monthly spending limit per category.</p>
            <div className="card">
              {CATEGORIES.map(c => (
                <div className="budget-input-row" key={c}>
                  <label className="budget-input-label">{CAT_EMOJI[c]} {c}</label>
                  <div className="budget-input-wrap">
                    <span className="rupee">₹</span>
                    <input type="number" placeholder="No limit" value={budgetInputs[c] || ''} min="0"
                      onChange={e => setBudgetInputs(b => ({ ...b, [c]: parseFloat(e.target.value) || '' }))}
                      className="budget-input" />
                  </div>
                </div>
              ))}
              <button className="btn-primary" style={{ marginTop: '1rem' }} onClick={saveBudgets}>Save budgets</button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
