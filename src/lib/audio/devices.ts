// Audio input device enumeration.
// Labels are only populated by the browser once mic permission has
// been granted at least once — if we see blank labels we request a
// throwaway getUserMedia() stream purely to unlock them, then stop it
// immediately and re-enumerate.

export async function listAudioInputs(): Promise<
  { deviceId: string; label: string }[]
> {
  try {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.enumerateDevices
    ) {
      return [];
    }

    let devices = await navigator.mediaDevices.enumerateDevices();
    let inputs = devices.filter((d) => d.kind === "audioinput");

    const needsPermission =
      inputs.length > 0 && inputs.every((d) => !d.label);

    if (needsPermission) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        stream.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
        inputs = devices.filter((d) => d.kind === "audioinput");
      } catch {
        // Permission denied or unavailable — fall through with
        // whatever (possibly label-less) devices we already have.
      }
    }

    return inputs.map((d) => ({
      deviceId: d.deviceId,
      label: d.label || "麦克风",
    }));
  } catch {
    return [];
  }
}
