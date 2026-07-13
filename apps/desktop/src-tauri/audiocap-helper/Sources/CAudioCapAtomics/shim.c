// No standalone symbols to compile here — every operation
// CAudioCapAtomics exposes is a `static inline` wrapper declared in
// include/CAudioCapAtomics.h. This translation unit exists only because
// SwiftPM's C-family targets require at least one source file in the
// target's own directory to build against; see that header for the
// actual implementation and the reasoning behind it.
#include "include/CAudioCapAtomics.h"
