export type Tone = 'warm' | 'simple' | 'playful';
export type Goal = 'new' | 'daily' | 'event';
export interface Brand { name: string; tagline: string; location: string; instagram: string; color: string; }
export interface Brief { productName: string; description: string; price: string; tone: Tone; goal: Goal; includeSchedule?: boolean; scheduleStartDate?: string; }
export interface Photo { id: string; name: string; dataUrl: string; storagePath?: string; unavailable?: boolean; }
export type CardLayout = 'editorial' | 'minimal' | 'bold' | 'split' | 'poster' | 'menu';
export interface ContentCardStyle { textColor?: string; backgroundColor?: string; fontScale?: number; align?: 'left' | 'center' | 'right'; }
export interface ContentCard { id: string; title: string; subtitle: string; eyebrow: string; body: string; imageId: string; layout: CardLayout; style?: ContentCardStyle; }
export interface ScheduleItem { day: string; title: string; format: string; description: string; date?: string; }
export interface ContentPack { source: 'ai' | 'template'; cards: ContentCard[]; caption: string; hashtags: string[]; schedule: ScheduleItem[]; }
export interface PhotoChatMessage { role: 'user' | 'assistant'; content: string; }
export type PhotoChats = Record<string, PhotoChatMessage[]>;
export interface Project { id: string; name: string; updatedAt: string; brand: Brand; brandId?: string; brief: Brief; photos: Photo[]; pack: ContentPack; photoChats?: PhotoChats; }
