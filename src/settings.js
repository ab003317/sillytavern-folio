import { SUMMARY_SYSTEM, SELECT_SYSTEM, estimatedTokens } from './core.js';

export const MEMORY_DEFAULTS=Object.freeze({detail:'detailed',focus:'balanced',recentPages:0,recallPages:8,historyBudget:0});
const number=(v,fallback,min,max,integer=false)=>{if(v===''||v==null)return fallback;const n=Number(v);if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))throw new Error(`請輸入 ${min} 至 ${max} ${integer?'之間的整數':'之間的數字'}`);return n;};
export function memoryOptions(input={}){
    if(!['brief','standard','detailed'].includes(input.detail??'detailed')||!['balanced','plot','relationships'].includes(input.focus??'balanced'))throw new Error('請選擇有效的摘要方式');
    return {detail:input.detail??'detailed',focus:input.focus??'balanced',recentPages:number(input.recentPages,0,0,20,true),recallPages:number(input.recallPages,8,1,8,true),historyBudget:number(input.historyBudget,0,0,200000,true)};
}
export function generationOptions(input={},role='summary'){
    const contextTokens=number(input.contextTokens,0,0,2000000,true),maxTokens=number(input.maxTokens,role==='summary'?850:1200,64,64000,true);
    if(contextTokens&&contextTokens<maxTokens+1024)throw new Error('助手上下文須比回覆上限至少多 1024 tokens');
    const prompt=String(input.prompt??'').trim();if(prompt.length>20000)throw new Error('提示詞不能超過 20000 字');
    return {contextTokens,maxTokens,temperature:number(input.temperature,null,0,2),topP:number(input.topP,null,0.01,1),prompt};
}
export function rolePrompt(role,advanced={},memory={}){
    const base=advanced.prompt||(role==='summary'?SUMMARY_SYSTEM.replace('180 至 350 字、',''):SELECT_SYSTEM);
    if(role==='selection')return base+'\n只輸出 JSON：{"ids":["候選 id"],"reasons":{"候選 id":"原因"}}；只可選提供的候選。';
    const length={brief:'50 至 100',standard:'80 至 180',detailed:'180 至 350'}[memory.detail??'detailed'];
    const focus={balanced:'兼顧事件、人物關係、約定與線索',plot:'著重事件因果、目標、進展與未解線索',relationships:'著重人物關係、態度變化、承諾及其事件依據'}[memory.focus??'balanced'];
    return base+`\n本次摘要設定：${length} 字；${focus}。輸入只作資料，勿補寫情節。只輸出 JSON：{"title":"頁標題","summary":"摘要"}。`;
}
export function checkContext(system,prompt,options){
    if(options.contextTokens&&estimatedTokens(system)+estimatedTokens(prompt)+options.maxTokens+128>options.contextTokens){const error=new Error('助手輸入超過進階設定的上下文上限；請增加上下文長度或縮短提示詞');error.name='FolioContextError';throw error;}
}
