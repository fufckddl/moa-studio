import { type ReactNode, useMemo, useState } from 'react';
import type { Project } from '../types';
import './library.css';

interface Props {
  projects: Project[];
  onOpen: (project: Project) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  brandFilter?: ReactNode;
  readOnly?: boolean;
  onLogin?: () => void;
}

type SortKey = 'recent' | 'oldest' | 'name';

const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function normalize(value: string) {
  return value.trim().toLocaleLowerCase('ko-KR');
}

function searchableText(project: Project) {
  return [
    project.name,
    project.brand.name,
    project.brief.productName,
    project.brief.description,
    project.pack.caption,
    ...project.pack.hashtags,
    ...project.pack.cards.flatMap((card) => [card.title, card.subtitle, card.eyebrow, card.body]),
  ].join(' ');
}

function cardCount(project: Project) {
  return `${project.pack.cards.length}개 카드뉴스`;
}

function projectCoverTitle(project: Project) {
  return project.pack.cards[0]?.title || project.brief.productName || project.name;
}

export function Library({ projects, onOpen, onDelete, onNew, brandFilter, readOnly = false, onLogin }: Props) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('recent');

  const visibleProjects = useMemo(() => {
    const term = normalize(query);
    return projects
      .filter((project) => !term || normalize(searchableText(project)).includes(term))
      .sort((first, second) => {
        if (sortKey === 'name') return first.name.localeCompare(second.name, 'ko-KR');
        const firstTime = new Date(first.updatedAt).getTime();
        const secondTime = new Date(second.updatedAt).getTime();
        return sortKey === 'oldest' ? firstTime - secondTime : secondTime - firstTime;
      });
  }, [projects, query, sortKey]);

  const hasProjects = projects.length > 0;
  const hasResults = visibleProjects.length > 0;

  return (
    <section className="library-surface" aria-labelledby="library-title">
      <header className="library-hero">
        <div>
          <h1 id="library-title">보관함</h1>
          <p>저장한 콘텐츠를 빠르게 찾아 이어서 편집하세요.</p>
        </div>
        <button className="primary-button library-create" type="button" onClick={onNew} disabled={readOnly}>
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          {readOnly ? '로그인하고 만들기' : '새 콘텐츠 만들기'}
        </button>
      </header>
      {readOnly ? <div className="read-only-notice library-read-only" role="status"><span>비회원은 보관함을 보기만 할 수 있어요. 로그인하면 새 콘텐츠 만들기와 삭제를 사용할 수 있습니다.</span>{onLogin ? <button className="ghost-button" type="button" onClick={onLogin}>로그인</button> : null}</div> : null}

      <div className="library-tools">
        <label className="library-search">
          <span className="sr-only">검색</span>
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.7" />
            <path d="m16.2 16.2 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            placeholder="검색"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <div className="library-sort-row">
          {brandFilter && <div className="library-brand-filter-slot">{brandFilter}</div>}
          <label className="library-sort">
            <span className="sr-only">정렬</span>
            <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
              <option value="recent">최근 수정순</option>
              <option value="oldest">오래된 순</option>
              <option value="name">이름순</option>
            </select>
          </label>
          <p aria-live="polite">
            전체 <strong>{visibleProjects.length}</strong>개 콘텐츠
          </p>
        </div>
      </div>

      {!hasProjects && (
        <LibraryEmpty
          title="첫 콘텐츠를 저장해보세요"
          description="새 콘텐츠를 만들고 저장하면 이곳에서 다시 열 수 있어요."
          actionLabel={readOnly ? '로그인 필요' : '콘텐츠 만들기'}
          onNew={onNew}
          readOnly={readOnly}
        />
      )}

      {hasProjects && !hasResults && (
        <LibraryEmpty
          title="검색 결과가 없어요"
          description="다른 브랜드명이나 콘텐츠 제목으로 다시 찾아보세요."
          actionLabel="새 콘텐츠 만들기"
          onNew={onNew}
          readOnly={readOnly}
          compact
        />
      )}

      {hasResults && (
        <div className="project-grid" aria-label="저장된 콘텐츠">
          {visibleProjects.map((project) => (
            <article className="project-card" key={project.id}>
              <button className="project-open" type="button" onClick={() => onOpen(project)}>
                <span className="project-cover" style={{ backgroundColor: project.brand.color }}>
                  {project.photos[0] && <img src={project.photos[0].dataUrl} alt="" />}
                  <span className="project-cover-label">{project.brand.name}</span>
                </span>
                <span className="project-meta">
                  <span>
                    <span className="project-brand">{project.brand.name}</span>
                    <h2>{project.name}</h2>
                  </span>
                  <span className="project-summary">
                    <time dateTime={project.updatedAt}>{dateFormatter.format(new Date(project.updatedAt))}</time>
                    <span>{cardCount(project)}</span>
                  </span>
                </span>
                <span className="project-preview-title">{projectCoverTitle(project)}</span>
              </button>
              <div className="project-actions">
                <button className="project-icon-button" type="button" onClick={() => onOpen(project)} aria-label={`${project.name} 열기`}>
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M8 6h10v10M18 6 6 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button className="project-icon-button project-delete" type="button" onClick={() => onDelete(project.id)} disabled={readOnly} aria-label={`${project.name} 삭제`}>
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M9 6V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1M5 6h14M8 10v8M12 10v8M16 10v8M7 6l1 15h8l1-15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function LibraryEmpty({
  title,
  description,
  actionLabel,
  onNew,
  compact = false,
  readOnly = false,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onNew: () => void;
  compact?: boolean;
  readOnly?: boolean;
}) {
  return (
    <div className={`library-empty${compact ? ' compact' : ''}`}>
      <div className="empty-folder" aria-hidden="true">
        <svg width="62" height="48" viewBox="0 0 62 48" fill="none">
          <path d="M5 15.5c0-3.3 2.7-6 6-6h12.5l6 6H51c3.3 0 6 2.7 6 6v17c0 3.3-2.7 6-6 6H11c-3.3 0-6-2.7-6-6v-23Z" fill="#f3eadb" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5 24h52" stroke="currentColor" strokeWidth="1.5" />
          <path d="M22 31.5h18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
        <button className="primary-button library-empty-action" type="button" onClick={onNew} disabled={readOnly}>
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
