import { useEffect, useState } from 'react';
import type { Brand } from '../types';
import type { BrandProfile } from '../lib/auth';

interface Props {
  account?: boolean;
  busy?: boolean;
  readOnly?: boolean;
  brand: Brand;
  profiles: BrandProfile[];
  activeBrandId: string;
  brandLimit: 1 | 3;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onChange: (brand: Brand) => void;
  onLogin?: () => void;
  saveStatus?: string;
}

export function BrandSettings({ brand, profiles, activeBrandId, brandLimit, onSelect, onCreate, onDelete, onChange, onLogin, account, busy = false, readOnly = false, saveStatus = '' }: Props) {
  const [draft, setDraft] = useState(brand);
  useEffect(() => setDraft(brand), [brand]);
  function updateDraft(next: Brand) {
    setDraft(next);
    onChange(next);
  }
  const colors = ['#254a3b', '#604631', '#8a4d40', '#354b64', '#403647'];
  return <section className="settings-surface">
    <div className="page-intro"><h1>우리 카페다운, 한 가지 목소리.</h1><p>콘텐츠에 사용할 카페 정보와 기본 색상을 관리해요.</p></div>
    <div className="brand-profile-manager" aria-label="브랜드 프로필 관리">
      <div className="brand-profile-tabs" role="tablist" aria-label="브랜드 프로필">
        {profiles.map(profile => <button key={profile.id} type="button" role="tab" aria-selected={profile.id === activeBrandId} className={profile.id === activeBrandId ? 'brand-profile-tab active' : 'brand-profile-tab'} disabled={busy} onClick={() => onSelect(profile.id)}><span style={{ background: profile.color }} />{profile.name}</button>)}
      </div>
      <div className="brand-profile-actions">
        <span>{profiles.length} / {brandLimit}</span>
        <button type="button" className="ghost-button" onClick={onCreate} disabled={busy || readOnly || profiles.length >= brandLimit}>프로필 추가</button>
        <button type="button" className="ghost-button" onClick={() => onDelete(activeBrandId)} disabled={busy || readOnly || profiles.length === 0}>현재 프로필 삭제</button>
      </div>
    </div>
    {readOnly ? <div className="read-only-notice brand-read-only" role="status"><span>비회원은 브랜드 정보를 볼 수만 있어요. 로그인하면 브랜드 추가, 수정, 삭제를 사용할 수 있습니다.</span>{onLogin ? <button className="ghost-button" type="button" onClick={onLogin}>로그인</button> : null}</div> : null}
    {profiles.length === 0 ? <div className="brand-form"><h2>브랜드 프로필을 추가해 주세요</h2><p className="field-help">로그인하면 카페 이름과 색상을 저장하고 콘텐츠에 바로 사용할 수 있어요.</p><button type="button" className="primary-button" disabled={busy || readOnly} onClick={onCreate}>첫 프로필 추가</button></div> : <form className="brand-form" onSubmit={event => event.preventDefault()}>
      <div className="settings-heading"><span>01</span><h2>브랜드 프로필</h2></div>
      <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 0 }}>
      <label className="field-label">카페 이름<input required maxLength={30} value={draft.name} onChange={e => updateDraft({ ...draft, name: e.target.value })} /></label>
      <label className="field-label">한 줄 소개<input maxLength={70} value={draft.tagline} placeholder="당신의 일상에 작은 쉼표" onChange={e => updateDraft({ ...draft, tagline: e.target.value })} /></label>
      <div className="brand-field-row">
        <label className="field-label">위치 <span className="optional-label">선택</span><input maxLength={80} value={draft.location} placeholder="서울 성동구 연무장길 12" onChange={e => updateDraft({ ...draft, location: e.target.value })} /></label>
        <label className="field-label">인스타그램 <span className="optional-label">선택</span><input maxLength={50} value={draft.instagram} placeholder="@cafe_moa" onChange={e => updateDraft({ ...draft, instagram: e.target.value })} /></label>
      </div>
      <div className="settings-heading"><span>02</span><h2>브랜드 컬러</h2></div>
      <p className="field-help">일부 카드 레이아웃의 기본 배경색으로 사용해요. 카드에서 배경색을 직접 지정하면 그 색상이 우선해요.</p>
      <div className="color-options">{colors.map(color => <button type="button" key={color} aria-label={`${color} 색상 선택`} aria-pressed={draft.color === color} className={`color-swatch ${draft.color === color ? 'selected' : ''}`} style={{ background: color }} onClick={() => updateDraft({ ...draft, color })}>{draft.color === color ? '✓' : ''}</button>)}<label className="custom-color">직접 선택<input type="color" aria-label="브랜드 색상 직접 선택" value={draft.color} onChange={e => updateDraft({ ...draft, color: e.target.value })} /></label></div>
      </fieldset>
      <div className="brand-preview" style={{ borderLeftColor: draft.color }}><span className="brand-preview-label">브랜드 정보 요약</span><strong style={{ color: draft.color }}>{draft.name || '카페 이름'}</strong><p>{draft.tagline}</p></div>
      <p className="field-help">위 박스는 브랜드 정보 요약이에요. 실제 카드 디자인은 콘텐츠 만들기 화면에서 확인하고 편집할 수 있어요.</p>
      <p className="field-help" role="status">{saveStatus || (account ? '브랜드 정보는 로그인한 계정에 자동 저장됩니다.' : '로그인하면 브랜드 정보를 계정에 저장할 수 있어요.')}</p>
    </form>}
  </section>;
}
