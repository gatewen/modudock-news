import json
import threading
import unittest

from back.news import Outbox


class BlockedStream:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.cv = threading.Condition()
        self.packets = []

    def write(self, data):
        self.entered.set()
        self.release.wait()
        with self.cv:
            self.packets.append(json.loads(data))
            self.cv.notify_all()

    def flush(self):
        pass


class OutboxCoalescingTests(unittest.TestCase):
    def setUp(self):
        self.stream = BlockedStream()
        self.outbox = Outbox(self.stream)
        self.addCleanup(self.finish)
        self.assertTrue(self.outbox.put(self.listing(0)))
        self.assertTrue(self.stream.entered.wait(2))

    def finish(self):
        self.outbox.close_with()
        self.stream.release.set()
        self.outbox.writer.join(2)
        self.assertFalse(self.outbox.writer.is_alive())

    def listing(self, n):
        return {'t':'msg','seq':1,'body':{'op':'list','items':[], 'n':n}}

    def drain(self, count):
        self.stream.release.set()
        with self.stream.cv:
            self.assertTrue(self.stream.cv.wait_for(lambda:len(self.stream.packets)>=count, 2))
        return self.stream.packets

    def test_in_progress_list_plus_only_last_of_ten_queued_lists(self):
        for n in range(1,11): self.assertTrue(self.outbox.put(self.listing(n)))
        self.assertEqual(self.outbox.queue.qsize(),1)
        self.assertEqual(self.drain(2),[self.listing(0),self.listing(10)])

    def test_replacement_keeps_publish_control_and_other_messages_in_place(self):
        publish1={'t':'publish','seq':1,'topic':'news.fetched','body':{'count':1}}
        ready={'t':'ready','seq':1}
        publish2={**publish1,'body':{'count':2}}
        other={'t':'msg','seq':1,'body':{'op':'status'}}
        for packet in [publish1,ready,self.listing(1),publish2,other]:
            self.assertTrue(self.outbox.put(packet))
        for n in range(2,11): self.assertTrue(self.outbox.put(self.listing(n)))
        self.assertEqual(self.outbox.queue.qsize(),5)
        self.assertEqual(self.drain(6),[self.listing(0),publish1,ready,self.listing(10),publish2,other])

    def test_full_queue_replaces_list_before_overflow_and_close_still_preserves_controls(self):
        ready={'t':'ready','seq':1}
        self.outbox.put(ready)
        self.outbox.put(self.listing(1))
        for i in range(30): self.outbox.put({'t':'publish','seq':1,'body':{'i':i}})
        self.assertEqual(self.outbox.queue.qsize(),32)
        self.assertTrue(self.outbox.put(self.listing(10)))
        with self.outbox.queue.mutex:
            self.assertEqual(self.outbox.queue.queue[1][0],self.listing(10))
        self.assertFalse(self.outbox.put({'t':'msg','seq':1,'body':{'op':'other'}}))
        terminal={'t':'done','seq':1}
        self.outbox.close_with(terminal)
        self.assertFalse(self.outbox.put(self.listing(11)))
        self.assertEqual(self.drain(3),[self.listing(0),ready,terminal])

    def test_full_queue_without_list_uses_original_drop_and_control_rules(self):
        for i in range(32): self.assertTrue(self.outbox.put({'t':'publish','seq':1,'body':{'i':i}}))
        self.assertFalse(self.outbox.put(self.listing(1)))
        with self.assertRaisesRegex(RuntimeError,'control outbox full'):
            self.outbox.put({'t':'ready','seq':1})
