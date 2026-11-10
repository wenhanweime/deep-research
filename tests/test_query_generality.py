"""Domain-neutral contract tests. Fixtures test execution, not model intelligence."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from query_planner import PlanError, validate_plan
from semantic import run_semantic


def need(key, question, deps=(), status='open', refs=()):
    return {'id':key, 'question':question, 'answer_criteria':'直接回答问题的可核查证据',
            'depends_on':list(deps), 'status':status, 'evidence_urls':list(refs)}


def query(key, *concepts, purpose='discover'):
    return {'need_id':key, 'concepts':[{'text':text,'kind':kind} for text,kind in concepts],
            'purpose':purpose, 'operation':'exact', 'rationale':'检索该信息缺口',
            'evidence_urls':[], 'planes':['smart'], 'sites':[]}


def plan(needs, queries=(), relevant=(), sufficient=False, constraints=()):
    return {'task':{'target':'问题的答案','intent':'回答研究问题','hard_constraints':list(constraints),
                    'preferences':[], 'unknowns':[]}, 'information_needs':needs, 'relations':[],
            'review':{'relevant_urls':list(relevant),'rejected':[],'candidates':[],
                      'gaps':[] if sufficient else ['需核查证据'], 'constraints_unknown':[],
                      'sufficient':sufficient}, 'queries':list(queries)}


class Planner:
    def __init__(self, plans): self.plans, self.requests = plans, []
    def decide(self, req):
        self.requests.append(copy.deepcopy(req))
        return validate_plan(copy.deepcopy(self.plans[len(self.requests)-1]), req)


class GeneralityTests(unittest.TestCase):
    def request(self, text='研究问题', evidence=()):
        return {'query':text,'task':{},'information_needs':[], 'evidence':list(evidence),
                'available_planes':['smart'],'available_sites':[], 'query_limit':4,'final':False}

    def test_independent_research_does_not_wait_for_unrelated_identity_resolution(self):
        n=[need('identity','术语指什么？'), need('effect','远程办公的产出影响？')]
        p=Planner([plan(n,[query('identity',('陌生术语','entity'),purpose='resolve'),
                           query('effect',('remote work','category'),('productivity','category'))]),plan(n)])
        calls=[]
        def retrieve(fs):
            calls.extend(fs);return [([{'url':'https://fixture.test/'+str(i),'title':'研究资料','snippet':'fixture'}],{}) for i,_ in enumerate(fs)]
        run_semantic('术语释义和远程办公影响',p,retrieve,planes={'smart'},sites=set(),rounds=1)
        self.assertEqual(len(calls),2)
        self.assertEqual({f['provenance']['need_id'] for f in calls},{'identity','effect'})

    def test_unanswered_dependency_blocks_only_its_query(self):
        n=[need('category','类别是什么？'),need('implementations','有哪些实现？',['category'])]
        with self.assertRaisesRegex(PlanError,'unanswered'):
            validate_plan(plan(n,[query('implementations',('实现','category'))]),self.request())
        validate_plan(plan(n,[query('category',('技术术语','category'))]),self.request())

    def test_explanation_without_entity_candidates_can_answer_needs(self):
        source={'url':'https://fixture.test/study','title':'实验报告','snippet':'这是测试夹具，不是真实研究证据。'}
        n=[need('effect','是否存在因果影响？')]
        final=plan([need('effect','是否存在因果影响？',status='answered',refs=[source['url']])],
                   relevant=[source['url']],sufficient=True)
        p=Planner([plan(n,[query('effect',('remote work','category'),('randomized trial','category'))]),final])
        result=run_semantic('远程办公是否提升生产率',p,lambda fs:[([source],{})],planes={'smart'},sites=set(),rounds=1)
        self.assertEqual(result['stop_reason'],'evidence_sufficient')
        self.assertEqual(result['mined_terms'],[])
        self.assertEqual(p.requests[-1]['information_needs'][0]['id'],'effect')

    def test_answered_dependency_unblocks_followup(self):
        source={'url':'https://fixture.test/terms','title':'术语','snippet':'技术术语说明'}
        n=[need('terms','文档使用什么术语？',status='answered',refs=[source['url']]),
           need('solutions','有哪些方案？',['terms'])]
        validate_plan(plan(n,[query('solutions',('hybrid search','category'),('open source','qualifier'))]),self.request(evidence=[source]))

    def test_cycles_and_unknown_dependencies_are_rejected(self):
        for n in ([need('a','A',['b']),need('b','B',['a'])],[need('a','A',['missing'])]):
            with self.assertRaises(PlanError): validate_plan(plan(n),self.request())

    def test_needs_cannot_disappear_or_be_answered_without_evidence(self):
        req=self.request();req['information_needs']=[need('scope','范围是什么？')]
        with self.assertRaisesRegex(PlanError,'dropped'):validate_plan(plan([]),req)
        with self.assertRaisesRegex(PlanError,'observed evidence'):
            validate_plan(plan([need('scope','范围是什么？',status='answered')]),req)

    def test_sufficiency_requires_answered_needs(self):
        with self.assertRaisesRegex(PlanError,'unanswered'):
            validate_plan(plan([need('why','原因是什么？')],sufficient=True),self.request())

    def test_exact_error_is_preserved_beyond_normal_phrase_length(self):
        error="TypeError: Cannot read properties of undefined (reading 'map') at renderDashboardComponent"
        p=validate_plan(plan([need('cause','报错的原因？')],[query('cause',(error,'literal'))]),self.request(error))
        self.assertEqual(p['queries'][0]['query'],'"'+error+'"')

    def test_titles_and_normal_vocabulary_are_not_rejected_by_substring_blacklists(self):
        for text,kind in [('如何阅读一本书','entity'),('电脑周边设备','category'),
                          ('中华人民共和国国民经济和社会发展第十四个五年规划纲要','entity')]:
            p=validate_plan(plan([need('topic','资料在哪里？')],[query('topic',(text,kind))]),self.request(text))
            self.assertEqual(p['queries'][0]['query'],text)

    def test_term_mapping_and_comparison_do_not_need_place_entities(self):
        n=[need('meaning','口语描述对应什么检索技术？'),need('compare','两种策略各有什么证据？')]
        p=validate_plan(plan(n,[query('meaning',('query expansion','category'),('enterprise search','category')),
                               query('compare',('hybrid search','category'),('benchmark','category'))],
                             constraints=['开源','本地部署']),self.request('找开源、本地部署的企业搜索方案'))
        self.assertEqual(len(p['queries']),2)
        self.assertEqual(p['task']['hard_constraints'],['开源','本地部署'])


if __name__=='__main__': unittest.main()
