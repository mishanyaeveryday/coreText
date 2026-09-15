(() => {
  const text = document.body?.innerText ?? "";
  const html = document.documentElement.outerHTML;

  console.group(`coreText: ${document.title || location.href}`);
  console.log("URL:", location.href);
  console.log("Text:", text);
  console.log("HTML:", html);
  console.groupEnd();
})();
