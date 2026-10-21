import React, { useEffect, useRef, useState } from 'react';
import { User, UserRole } from '../types';
import { StorageService, memberTierLabel, normalizePhone } from '../mockData';
import * as api from '../api';

// A phone box with a dropdown of matching members: type part of a phone
// number or a name, then pick the customer (click, or arrows + Enter).
// Typing a number that is not listed still works - it just earns no points.
export default function MemberPhoneInput({ id, value, onChange, onPick, placeholder, className, dark, required }: {
  id?: string;
  value: string;
  onChange: (phone: string) => void;
  onPick?: (m: api.MemberMatch) => void;
  placeholder?: string;
  className?: string;
  dark?: boolean;
  required?: boolean;
}) {
  const [matches, setMatches] = useState<api.MemberMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [searched, setSearched] = useState('');
  const picked = useRef('');
  const listId = (id || 'member-phone') + '-list';

  useEffect(() => {
    const q = value.trim();
    if (q.length < 2 || q === picked.current) {
      setMatches([]);
      setSearched('');
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      let list: api.MemberMatch[] = [];
      if (api.USE_BACKEND) {
        list = await api.searchMembers(q).catch(() => []);
      } else {
        const digits = normalizePhone(q).replace(/\D/g, '');
        const name = q.toLowerCase();
        list = StorageService.get<User[]>('users', [])
          .filter(u => u.role === UserRole.CUSTOMER && u.isActive !== false &&
            ((digits.length >= 2 && normalizePhone(u.phone).startsWith(digits)) || u.name.toLowerCase().includes(name)))
          .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8)
          .map(u => ({ id: u.id, name: u.name, phone: normalizePhone(u.phone), memberType: u.memberType, points: u.points ?? 0 }));
      }
      if (stale) return;
      setMatches(list);
      setSearched(q);
      setActive(list.length ? 0 : -1);
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [value]);

  const pick = (m: api.MemberMatch) => {
    picked.current = m.phone;
    onChange(m.phone);
    onPick?.(m);
    setOpen(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || !matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % matches.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + matches.length) % matches.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(matches[active]); }
    else if (e.key === 'Escape') setOpen(false);
  };

  const showList = open && searched !== '' && searched === value.trim();
  const box = dark ? 'bg-slate-800 border-slate-600 text-white' : 'bg-white border-slate-200 text-slate-800';
  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        inputMode="tel"
        autoComplete="off"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        required={required}
        value={value}
        placeholder={placeholder}
        onChange={e => { picked.current = ''; onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
        className={className}
      />
      {showList && (
        <ul id={listId} role="listbox" className={`absolute z-30 left-0 right-0 mt-1 max-h-60 overflow-y-auto rounded-lg border shadow-lg text-xs ${box}`}>
          {matches.length === 0 && (
            <li className="px-3 py-2 opacity-70">ไม่พบสมาชิก — พิมพ์เบอร์ต่อได้ (ไม่ได้รับแต้มถ้ายังไม่สมัครสมาชิก)</li>
          )}
          {matches.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={e => { e.preventDefault(); pick(m); }}
              onMouseEnter={() => setActive(i)}
              className={`px-3 py-2 cursor-pointer flex justify-between gap-2 ${i === active ? (dark ? 'bg-slate-700' : 'bg-emerald-50') : ''}`}
            >
              <span><b>{m.name}</b> <span className="font-mono opacity-80">{m.phone}</span></span>
              <span className="opacity-70 whitespace-nowrap">{memberTierLabel(m.memberType).replace(/\s*\(.*\)$/, '')} · {m.points} แต้ม</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
