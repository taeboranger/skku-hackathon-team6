self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let d;
      try {
        d = event.data ? event.data.json() : null;
      } catch {
        const text = event.data ? event.data.text() : "새 알림이 도착했어요.";
        d = {
          title: "스꾸핑 알림",
          body: text,
          answerType: "text",
          requestId: "test-" + Date.now(),
        };
      }
      if (!d) return;
      await self.registration.showNotification(d.title, {
        body: d.body,
        icon: "/favicon.svg",
        tag: d.requestId,
        data: d,
        actions:
          d.answerType === "yes_no"
            ? [
                { action: "yes", title: "네" },
                { action: "no", title: "아니요" },
              ]
            : [{ action: "reply", title: "짧게 답변하기" }],
      });
      if (d.requestId) {
        try {
          await fetch("/api/seen", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId: d.requestId }),
          });
        } catch {}
      }
    })(),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const d = event.notification.data;
      let done = false;
      if (event.action === "yes" || event.action === "no") {
        try {
          const r = await fetch("/api/answers", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              questionId: d.questionId,
              recipientId: d.recipientId,
              body: event.action === "yes" ? "네" : "아니요",
            }),
          });
          done = r.ok;
        } catch {}
      }
      const url =
        "/?question=" +
        encodeURIComponent(d.questionId) +
        (done ? "&answered=1" : "");
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      if (clients.length) {
        await clients[0].navigate(url);
        await clients[0].focus();
      } else await self.clients.openWindow(url);
    })(),
  );
});
