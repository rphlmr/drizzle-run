/**
 * The Delete dialog's description
 *
 * Says what leaves this browser, and, when some of the projects are Cloud, that they leave the account and the other
 * browsers too. When some have a share link, says the share stays public and where to delete it.
 */
export function describeProjectDeletion({
  names,
  cloudCount,
  sharedCount,
}: {
  names: readonly string[];
  cloudCount: number;
  sharedCount: number;
}) {
  const [onlyName] = names;
  const subject = names.length === 1 && onlyName !== undefined ? onlyName : "them";
  const backup =
    names.length === 1 ? "Export a JSON backup first if you need it." : "Export a JSON backup first if you need them.";
  const shares = describeKeptShares({ count: names.length, sharedCount });
  const kept = [shares, backup].filter((part) => part !== "").join(" ");

  if (cloudCount === 0) {
    return `This removes ${subject} from this browser. ${kept}`;
  }

  const cloud =
    cloudCount === names.length
      ? "your account and your other browsers"
      : "and the Cloud ones from your account and your other browsers";

  return `This removes ${subject} from this browser, ${cloud}. ${kept}`;
}

function describeKeptShares({ count, sharedCount }: { count: number; sharedCount: number }) {
  if (sharedCount === 0) {
    return "";
  }

  const links =
    count === 1
      ? "Its share link stays public. To take it down, stop sharing it from Share first."
      : sharedCount === count
        ? "Their share links stay public. To take them down, stop sharing each from Share first."
        : "The share links of the shared ones stay public. To take them down, stop sharing each from Share first.";

  return `${links} Shares made while signed in can also be stopped later from My shares.`;
}
