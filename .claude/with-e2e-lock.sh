#!/bin/sh
# Run a command while holding the shared Drizzle Run e2e lock
#
# Each worktree serves its checks on its own ports (scripts/drizzle-run-ports.ts), but browser suites side by side
# overload the machine and flake, so only one runs at a time. The lock is a file in the repository's shared git dir,
# which every worktree sees, held with flock(2) by this script while the command runs in its own process group. When
# the command ends, even killed by a timeout, the script stops what is left of that group, such as a server it started,
# and exits, and the system releases the lock. A signal sent to the script reaches the whole group. Only a script killed
# with SIGKILL leaves the command running without the lock.
#
# Usage, from any worktree:
#   sh <main checkout>/.claude/with-e2e-lock.sh <label> <command...>
# Example:
#   sh .../with-e2e-lock.sh worker-drizzle pnpm test:e2e

set -u

if [ "$#" -lt 2 ]; then
  echo "Usage: with-e2e-lock.sh <label> <command...>" >&2
  exit 2
fi

lock_file="$(git rev-parse --git-common-dir)/drizzle-run-e2e.lock"

exec perl -e '
  use strict;
  use Fcntl qw(:flock);

  my ($lock_file, $label, @command) = @ARGV;
  my $wait_seconds = 20;

  open(my $lock, "+>>", $lock_file) or die "e2e lock: cannot open $lock_file: $!\n";

  until (flock($lock, LOCK_EX | LOCK_NB)) {
    seek($lock, 0, 0);
    my $owner = <$lock> // "owner not written yet";
    chomp $owner;
    print STDERR "e2e lock: busy ($owner), retrying in ${wait_seconds}s\n";
    sleep $wait_seconds;
  }

  truncate($lock, 0);
  syswrite($lock, "$$ $label " . localtime() . "\n");

  print STDERR "e2e lock: held by $label\n";

  my $child = fork() // die "e2e lock: cannot start $command[0]: $!\n";

  if ($child == 0) {
    setpgrp(0, 0);
    exec { $command[0] } @command or die "e2e lock: cannot run $command[0]: $!\n";
  }

  setpgrp($child, $child);

  for my $signal (qw(INT TERM HUP ALRM)) {
    $SIG{$signal} = sub { kill $signal, -$child };
  }

  until (waitpid($child, 0) == $child) {}
  my $status = $?;

  kill "TERM", -$child;
  exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);
' "$lock_file" "$@"
