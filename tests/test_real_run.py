"""Offline subprocess smoke tests for the real-run reporting script."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class RealRunTests(unittest.TestCase):
    def test_completed_round_usage_summary_includes_retries_without_summing_totals(self):
        for stats, expected in [([
            'model round=1 requests=1 http=3 retries=2 total_http=3',
            'model round=2 requests=1 http=2 retries=1 total_http=5'],
            'requests=2 http=5 retries=3'),
            (['model round=1 requests=2'], 'requests=2 http=unknown retries=unknown')]:
            with self.subTest(stats=stats), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root/'back').mkdir()
                (root/'back/news.py').write_text('''import json, sys
for line in sys.stdin:
    packet=json.loads(line)
    if packet['t']=='hello': print(json.dumps({'t':'ready','seq':packet['seq']}),flush=True)
    elif packet['t']=='up':
        for stat in STATS: print(stat,file=sys.stderr,flush=True)
        print(json.dumps({'t':'msg','body':{'op':'list','items':[],'sources':[],
            'model':{'state':'done'},'topics':{'list':[]}}}),flush=True)
    elif packet['t']=='bye': break
'''.replace('STATS', repr(stats)))
                result = subprocess.run([sys.executable, 'scripts/real_run.py', '--root', directory,
                                         '--timeout', '3'], capture_output=True, text=True, timeout=6,
                                        env={k:v for k,v in os.environ.items() if k!='TYPESAFE_API_KEY'})
                self.assertEqual(result.returncode,0,result.stdout+result.stderr)
                self.assertIn('result=done exit=0',result.stdout)
                self.assertIn('model_usage (completed rounds): '+expected,result.stdout)
