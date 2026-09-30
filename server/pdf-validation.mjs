import { parentPort, workerData } from "node:worker_threads";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Parse in an isolated, time-limited worker; never render or execute document actions.
const task = getDocument({
  data: workerData,
  isEvalSupported: false,
  useSystemFonts: false,
  stopAtErrors: true,
  verbosity: 0,
});
task.onPassword = () => {
  parentPort.postMessage(false);
  void task.destroy();
};
try {
  const pdf = await task.promise;
  const { info } = await pdf.getMetadata();
  parentPort.postMessage(
    info.EncryptFilterName === null && pdf.numPages >= 1 && pdf.numPages <= 30,
  );
} catch {
  parentPort.postMessage(false);
} finally {
  await task.destroy();
}
