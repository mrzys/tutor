import { isDeepStrictEqual } from 'node:util';
import { teachingReviewModelContract, teachingReviewResponseContract } from './teaching-sentence-patch.mjs';

// Transport projection only. The pipeline retains its full original candidates
// and findings; no source, proof, issue or match position is discarded here.
export function compactTeachingReviewContext(input) {
  const out = structuredClone(input);
  if (!out || typeof out !== 'object' || Array.isArray(out)) return out;
  if (out.candidate != null && isDeepStrictEqual(out.candidate, out.rawCandidate)) {
    out.rawCandidate = null;
    out.rawCandidateSameAsCandidate = true;
  }
  const rules = [];
  for (const finding of out.reviewFindings ?? []) {
    if (typeof finding?.guidance === 'string' && finding.guidance) {
      let index = rules.findIndex(rule => rule.ruleId === finding.ruleId && rule.guidance === finding.guidance);
      if (index < 0) {
        index = rules.length;
        rules.push({ ruleId: finding.ruleId, guidance: finding.guidance });
      }
      finding.reviewGuidanceIndex = index;
      delete finding.guidance;
    }
    // Older Rust scans stored the whole field in each excerpt. The full field
    // remains in candidate; send a Unicode-safe local context for each match.
    const text = generatedField(out.candidate, finding?.fieldPath);
    if (typeof text === 'string' && Number.isInteger(finding.start) && Number.isInteger(finding.end)
      && finding.start >= 0 && finding.end >= finding.start && finding.end <= text.length) {
      const before = Array.from(text.slice(0, finding.start)).slice(-40).join('');
      const after = Array.from(text.slice(finding.end)).slice(0, 40).join('');
      finding.excerpt = before + text.slice(finding.start, finding.end) + after;
    }
  }
  if (rules.length) out.reviewRules = rules;
  if(out.patchContract?.segmentPatchVersion===2){
    const contract=out.patchContract;
    const pick=(v,keys)=>Object.fromEntries(keys.filter(key=>v && Object.hasOwn(v,key)).map(key=>[key,v[key]]));
    out.patchContract=teachingReviewModelContract(contract);
    out.reviewResponseContract=teachingReviewResponseContract(contract);
    delete out.rawCandidate;delete out.rawCandidateSameAsCandidate;delete out.reviewMethodScopes;
    delete out.reviewPatchVersion;delete out.reviewResolutionVersion;delete out.classroomPolicyVersion;
    out.originalMaterial=pick(out.originalMaterial,['questionType','stem','options','parts','referenceAnswer','referenceSolution','sourceIssues','visuals']);
    out.candidate=pick(out.candidate,['answer','difficultyAssessment','teachingSolution','teachingFocus','issues']);
    out.reviewFindings=(out.reviewFindings||[]).map(f=>{
      const value=pick(f,['type','ruleId','category','fieldPath','start','end','term','quote','message','reason','issue','id','dimension','reviewGuidanceIndex','code','excerpt','origin']);
      if(f.type==='quality'){const at=(contract.qualityFindings||[]).findIndex(q=>q.id===f.id);if(at>=0)value.id=`q${at}`;}
      return value;
    });
    if(out.verifiedInputFacts)out.verifiedInputFacts=pick(out.verifiedInputFacts,['questionType']);
    if(out.operatorInputFacts)out.operatorInputFacts=pick(out.operatorInputFacts,['facts','author']);
    delete out.sourceContentSha256;delete out.candidateSha256;
  }
  return out;
}

/** Structural part boundaries only. No numbering guess grants a method scope. */
export function teachingMethodScopePreferences(context){
  const text=context?.candidate?.teachingSolution;if(typeof text!=='string'||!text)return {};
  const parts=context.originalMaterial?.parts??[], ranges=[];
  if(!Array.isArray(parts))return {};
  if(!parts.length)ranges.push({start:0,end:[...text].length,scopeBasis:'本题完整相关证明段'});
  else{
    // Only explicit source numbering can identify these generated headings as
    // question parts. Matching a count alone could mistake proof steps for parts.
    const labelNumber=part=>{
      if(typeof part?.label!=='string')return null;
      const label=part.label.trim();
      const match=/^(?:（([1-9][0-9]*)）|\(([1-9][0-9]*)\)|([1-9][0-9]*)[.．、]?)$/u.exec(label);
      const value=match&&Number(match[1]??match[2]??match[3]);return Number.isSafeInteger(value)?value:null;
    };
    if(!Array.isArray(parts)||parts.some((part,i)=>labelNumber(part)!==i+1))return {};
    const headings=[...text.matchAll(/^[ \t]*(?:\*\*)?[（(]\s*([0-9]+)\s*[)）]/gmu)];
    if(headings.length!==parts.length||headings.some((m,i)=>Number(m[1])!==i+1))return {};
    headings.forEach((m,i)=>ranges.push({start:[...text.slice(0,m.index)].length,end:[...text.slice(0,headings[i+1]?.index??text.length)].length,scopeBasis:`第（${i+1}）小问的完整相关证明段`}));
  }
  const scopes=[],seen=new Set();
  for(const f of context.reviewFindings||[]){
    if(f.fieldPath!=='teachingSolution'||!((f.type==='quality'&&f.dimension==='method')||(f.type==='term'&&(f.ruleId==='limit-notation'||f.category==='special_tool'))))continue;
    let a=f.start,b=f.end;
    if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b<=a||b>text.length||f.term&&text.slice(a,b)!==f.term){
      const literal=f.term||f.quote||f.oldText;if(typeof literal!=='string'||!literal||text.indexOf(literal)<0||text.indexOf(literal)!==text.lastIndexOf(literal))continue;
      a=text.indexOf(literal);b=a+literal.length;
    }
    a=[...text.slice(0,a)].length;b=[...text.slice(0,b)].length;
    const range=ranges.find(r=>r.start<=a&&b<=r.end);if(!range||range.end-range.start>6000||seen.has(range.start))continue;
    seen.add(range.start);scopes.push({fieldPath:'teachingSolution',...range,expectedText:[...text].slice(range.start,range.end).join('')});
  }
  return scopes.length?{reviewMethodScopes:scopes,methodReferences:[
    '方法参考须核对适用条件：若用对数判断数列的变化趋势，可考虑先证明u/(1+u)<ln(1+u)<u（u>0），代入后比较具体差值。不直接引用对数连续性或把整数已知擅自推广到实数。',
    '参数恒成立的必要性：若要否定某段参数范围，先设参数与待检验边界的正差，再用具体不等式明确选出一个正数或整数并代入验证；不能只写充分小、足够大或存在δ。'
  ]}:{};
}

function generatedField(candidate, path) {
  if (['answer', 'teachingSolution'].includes(path)) return candidate?.[path];
  if (path === 'difficultyAssessment.basis') return candidate?.difficultyAssessment?.basis;
  if (path === 'teachingFocus.examFocus') return candidate?.teachingFocus?.examFocus;
  const match = /^teachingFocus\.studentRequirements\[(\d+)\]$/u.exec(path ?? '');
  return match ? candidate?.teachingFocus?.studentRequirements?.[Number(match[1])] : undefined;
}
