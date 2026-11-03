import contextlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('research_helper',pathlib.Path(__file__).parents[1]/'remote'/'research_helper.py')
h=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(h)


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='research-helper-test-')
        self.root=pathlib.Path(self.temp.name);self.project=self.root/'project';self.project.mkdir()
        self.policy={'allowedRoots':[str(self.project)],'executables':[str(pathlib.Path(sys.executable).resolve())],
                     'environments':{'default':{}},'maxGpuCount':1,'reservationPython':sys.executable,'maxHolderBytes':64*1024**2,'maxProcessGpuBytes':256*1024**2,'maxHoldSeconds':60}
        h.atomic(self.root/'policy.json',self.policy)
        self.helper=h.Helper(self.root,collector=lambda:[])
        self.recipe={'root':str(self.project),'executable':str(pathlib.Path(sys.executable).resolve()),'args':['train.py'],'codeVersion':'latest_record','envRef':'default'}
        self.spec={'recipe':self.recipe,'validation':{'metricsFile':'metrics.json','requiredFiles':[]},'resource':{'gpuCount':0,'gpuUuids':[],'minFreeBytes':0,'maxUsedBytes':0,'holderBytes':16,'holdSeconds':30},'grant':{'submit':True,'reserve':True,'stop':False},'objectId':str(uuid.uuid4()),'selectedGpuUuids':[]}

    def tearDown(self):
        self.temp.cleanup()

    def request(self,action,payload,operation=None):
        data={'version':1,'operationId':operation or str(uuid.uuid4()),'ownerScope':'a'*64,'target':{'server':'fixture','bindingHash':'b'*64},'action':action,'payload':payload}
        data['payloadHash']=h.digest({key:data[key] for key in ['action','target','ownerScope','payload']});return data

    def lock_patch(self):
        if os.name=='posix':
            return contextlib.nullcontext()
        @contextlib.contextmanager
        def fake_lock(*args,**kwargs):
            yield
        return patch.object(h,'lock',fake_lock)

    def test_recipe_root_and_executable_are_bounded(self):
        self.helper.validate_recipe(self.recipe)
        with self.assertRaises(ValueError):
            self.helper.validate_recipe({**self.recipe,'root':str(self.root.parent)})
        with self.assertRaises(ValueError):
            self.helper.validate_recipe({**self.recipe,'executable':str(self.root/'unknown')})

    def test_submit_replay_never_repeats_tmux_even_if_only_intent_remains(self):
        request=self.request('submit',self.spec);launches=[]
        def run(argv,**kwargs):
            if argv[0]=='tmux':launches.append(argv)
            return subprocess.CompletedProcess(argv,0,stdout='',stderr='')
        with self.lock_patch(),patch.object(h.subprocess,'run',run):
            first=self.helper.handle(request);second=self.helper.handle(request)
            self.assertEqual(first['objectId'],second['objectId']);self.assertEqual(len(launches),1)
            self.assertNotIn('shell',{});self.assertEqual(launches[0][0:3],['tmux','new-session','-d'])
        bad={**request,'payload':{**self.spec,'recipe':{**self.recipe,'args':['other.py']}}}
        bad['payloadHash']=h.digest({key:bad[key] for key in ['action','target','ownerScope','payload']})
        with self.lock_patch(),self.assertRaises(ValueError):self.helper.handle(bad)

    @unittest.skipUnless(os.name=='posix','Native fcntl concurrency is exercised on Linux')
    def test_competing_requests_share_one_remote_operation(self):
        from concurrent.futures import ThreadPoolExecutor
        launches=[];request=self.request('submit',self.spec)
        def run(argv,**kwargs):
            if argv[0]=='tmux':launches.append(argv);time.sleep(0.02)
            return subprocess.CompletedProcess(argv,0,stdout='',stderr='')
        with patch.object(h.subprocess,'run',run),ThreadPoolExecutor(max_workers=4) as pool:
            receipts=list(pool.map(lambda _:self.helper.handle(request),range(4)))
        self.assertEqual(len(launches),1);self.assertEqual(len({r['objectId'] for r in receipts}),1)

    def test_missing_or_foreign_metrics_are_not_validated_success(self):
        job=self.spec['objectId'];file=self.helper.record_file(job)
        manifest={'objectId':job,'ownerScope':'a'*64,'state':'exited','kind':'job','recipe':self.recipe,'spec':self.spec,'validation':self.spec['validation'],'exitCode':0,'startedWallNs':0}
        h.atomic(file,manifest)
        response=self.helper.handle(self.request('inspect',{'objectId':job}))
        self.assertEqual(response['payload']['validationState'],'needs_review')
        h.atomic(self.project/'metrics.json',{'jobId':str(uuid.uuid4()),'value':1})
        response=self.helper.handle(self.request('inspect',{'objectId':job}))
        self.assertEqual(response['payload']['validationState'],'needs_review')
        h.atomic(self.project/'metrics.json',{'jobId':job,'value':1})
        response=self.helper.handle(self.request('inspect',{'objectId':job}))
        self.assertEqual(response['payload']['validationState'],'validated')
        manifest['startedWallNs']=time.time_ns()+10**9;h.atomic(file,manifest)
        response=self.helper.handle(self.request('inspect',{'objectId':job}))
        self.assertEqual(response['payload']['validationState'],'needs_review')

    def test_pid_reuse_cannot_stop_an_unrelated_process(self):
        saved={'bootId':'old','pid':12345,'startTicks':'10','pgid':12345}
        with patch.object(h,'identity',return_value={**saved,'startTicks':'11'}),patch.object(h.os,'killpg',create=True) as kill:
            self.assertFalse(h.stop_process(saved));kill.assert_not_called()

    def test_holder_deadline_survives_wall_clock_rollback(self):
        job=self.spec['objectId'];file=self.helper.record_file(job)
        h.atomic(file,{'spec':{**self.spec,'selectedGpuUuids':['GPU-fixture']},'deadline':2000000})
        allocation=[]
        class FakeAllocation:
            def __init__(self,*args):self.closed=False;allocation.append(self)
            def close(self):self.closed=True
        ticks=[0]
        def monotonic():ticks[0]+=1;return ticks[0]
        with patch.object(h.time,'monotonic',monotonic),patch.object(h.time,'time',return_value=1000),patch.object(h.time,'sleep'),patch.object(h,'identity',return_value={'pid':1}):
            h.hold(file,5,allocator=FakeAllocation)
        self.assertEqual(len(allocation),1);self.assertTrue(allocation[0].closed);self.assertLess(ticks[0],10)

    def test_handed_off_lease_cleanup_never_stops_the_training(self):
        job=self.spec['objectId'];file=self.helper.record_file(job)
        h.atomic(file,{'objectId':job,'ownerScope':'a'*64,'kind':'lease','state':'handed_off','spec':self.spec,'handoffJobId':str(uuid.uuid4())})
        with self.lock_patch(),patch.object(h,'stop_process') as stop:
            result=self.helper.handle(self.request('release',{'objectId':job}))
        self.assertEqual(result['state'],'handed_off');stop.assert_not_called()


if __name__=='__main__':
    unittest.main()
