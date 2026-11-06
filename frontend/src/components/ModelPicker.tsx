import { useMemo, useState } from 'react'
import type { ModelInfo } from '../types'
import { Icon, ProtocolBadge } from './ui'

export function ModelPicker({
  models,
  selected,
  onChange,
  onAddManual,
}: {
  models: ModelInfo[]
  selected: string[]
  onChange: (next: string[]) => void
  onAddManual: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [manual, setManual] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.ownedBy || '').toLowerCase().includes(q),
    )
  }, [models, query])

  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id))
    else onChange([...selected, id])
  }

  const selectAll = () => {
    const set = new Set(selected)
    filtered.forEach((m) => set.add(m.id))
    onChange([...set])
  }

  const addManual = () => {
    const id = manual.trim()
    if (!id) return
    onAddManual(id)
    setManual('')
  }

  return (
    <div className="model-picker">
      <div className="model-toolbar">
        <div className="search-box">
          <Icon name="search" size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型 ID 或提供方"
            spellCheck={false}
          />
        </div>
        <button type="button" className="btn tiny ghost" onClick={selectAll} disabled={!filtered.length}>
          全选
        </button>
        <button type="button" className="btn tiny ghost" onClick={() => onChange([])} disabled={!selected.length}>
          清空
        </button>
      </div>

      <div className="model-list">
        {models.length === 0 && (
          <div className="model-hint">
            先在上方点击「获取模型列表」，或直接在下方手动添加模型 ID。
          </div>
        )}
        {filtered.map((m) => {
          const checked = selected.includes(m.id)
          return (
            <label key={m.id} className={`model-row ${checked ? 'checked' : ''}`}>
              <input type="checkbox" checked={checked} onChange={() => toggle(m.id)} />
              <span className="checkbox-ui">
                <Icon name="check" size={12} />
              </span>
              <span className="model-id" title={m.id}>
                {m.id}
              </span>
              <ProtocolBadge protocol={m.protocol} />
              {m.ownedBy && <span className="model-owner">{m.ownedBy}</span>}
            </label>
          )
        })}
        {models.length > 0 && filtered.length === 0 && (
          <div className="model-hint">没有匹配「{query}」的模型</div>
        )}
      </div>

      <div className="manual-add">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addManual()
            }
          }}
          placeholder="手动添加模型 ID，例如 gpt-4o-mini"
          spellCheck={false}
        />
        <button type="button" className="btn secondary" onClick={addManual} disabled={!manual.trim()}>
          <Icon name="plus" size={15} />
          添加
        </button>
      </div>

      <div className="model-count">
        <span>
          已选择 <b>{selected.length}</b> 个模型
        </span>
        {selected.length > 0 && (
          <span className="model-chips">
            {selected.slice(0, 3).map((id) => (
              <span key={id} className="chip">{id}</span>
            ))}
            {selected.length > 3 && <span className="chip">+{selected.length - 3}</span>}
          </span>
        )}
      </div>
    </div>
  )
}
