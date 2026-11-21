"""Cooperative replay fence, held until the runner exits, across server restarts."""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass


class ControlError(Exception):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code


@dataclass
class _Control:
    active: int = 0
    token: str | None = None
    expires: float = 0
    draining: bool = False
    closing: bool = False


class ReplayControl:
    def __init__(self):
        self._changed = threading.Condition()
        self._seats: dict[str, _Control] = {}

    def _seat(self, seat_id: str) -> _Control:
        seat = self._seats.setdefault(seat_id, _Control())
        if seat.token is not None and seat.expires <= time.monotonic():
            seat.token = None
            seat.draining = False
            self._changed.notify_all()
        return seat

    @contextmanager
    def replay(self, seat_id: str):
        with self._changed:
            seat = self._seat(seat_id)
            if seat.closing:
                raise ControlError("SEAT_UNAVAILABLE", "This seat is closing.")
            if seat.token is not None:
                raise ControlError("HUMAN_IN_CONTROL", "A person is taking or using this screen.")
            seat.active += 1
        try:
            yield
        finally:
            with self._changed:
                seat.active -= 1
                if seat.active == 0 and seat.token is None and not seat.closing:
                    self._seats.pop(seat_id, None)
                self._changed.notify_all()

    @contextmanager
    def transition(self, seat_id: str, drain_ms: int = 5000):
        """The existing replay authority also fences profile teardown."""
        with self._changed:
            seat = self._seat(seat_id)
            if seat.token is not None or seat.closing:
                raise ControlError("HUMAN_IN_CONTROL", "Hand this screen back before closing it.")
            seat.closing = True
            self._changed.notify_all()
            deadline = time.monotonic() + drain_ms / 1000
            try:
                while seat.active:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ControlError("DRAIN_TIMEOUT", "The running replay did not finish; the profile remains reserved.")
                    self._changed.wait(remaining)
            except BaseException:
                seat.closing = False
                self._changed.notify_all()
                raise
        try:
            yield
        finally:
            with self._changed:
                seat.closing = False
                if seat.active == 0 and seat.token is None:
                    self._seats.pop(seat_id, None)
                self._changed.notify_all()

    def control(self, seat_id: str, action: str, token: str, *, lease_ms: int = 0,
                drain_ms: int = 0):
        with self._changed:
            seat = self._seat(seat_id)
            if seat.closing:
                raise ControlError("SEAT_UNAVAILABLE", "This seat is closing.")
            if action == "release":
                # An old server's cleanup must never release the new holder.
                if seat.token == token:
                    seat.token = None
                    seat.draining = False
                    if seat.active == 0:
                        self._seats.pop(seat_id, None)
                    self._changed.notify_all()
                return
            if action == "renew":
                if seat.token != token or seat.draining:
                    raise ControlError("STALE_EPOCH", "This remote control lease has ended.")
                seat.expires = time.monotonic() + lease_ms / 1000
                return
            if seat.token is not None:
                raise ControlError("HUMAN_IN_CONTROL", "This screen already has a control request.")
            deadline = time.monotonic() + drain_ms / 1000
            seat.token = token
            seat.draining = True
            seat.expires = deadline
            while seat.active:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or seat.token != token:
                    if seat.token == token:
                        seat.token = None
                        seat.draining = False
                        self._changed.notify_all()
                    raise ControlError("DRAIN_TIMEOUT", "The running replay did not drain.")
                self._changed.wait(remaining)
            if seat.token != token or deadline <= time.monotonic():
                if seat.token == token:
                    seat.token = None
                    seat.draining = False
                raise ControlError("DRAIN_TIMEOUT", "The control request has ended.")
            seat.draining = False
            seat.expires = time.monotonic() + lease_ms / 1000
