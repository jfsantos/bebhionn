# SCSP WASM build — compiles MAME's BSD-3-Clause SCSP emulator
# (extracted into scsp.cpp / scspdsp.cpp) plus the Bebhionn C bridge
# (scsp_wasm.cpp) and waveform helpers (scsp_waveforms.c) to WebAssembly.
CC  = emcc
CXX = emcc

# Shared flags
COMMON = -O2 \
	-s WASM=1 \
	-s MODULARIZE=1 \
	-s EXPORT_NAME='SCSPModule' \
	-s EXPORTED_FUNCTIONS='["_scsp_init","_scsp_get_ram_ptr","_scsp_get_ram_size","_scsp_write_reg","_scsp_write_slot","_scsp_key_on","_scsp_key_off","_scsp_render","_scsp_get_render_buf","_scsp_dsp_load_exb","_scsp_dsp_load_arrays","_scsp_dsp_stop","_scsp_dsp_start","_scsp_dsp_clear","_scsp_slot_set_effect_send","_scsp_slot_set_effect_output","_scsp_dsp_get_efreg","_scsp_dsp_set_coef","_scsp_dsp_get_coef","_scsp_dsp_set_madrs","_scsp_dsp_get_madrs","_scsp_slot_set_direct_output","_malloc","_free"]' \
	-s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAP16","HEAPU8","HEAPU16"]' \
	-s ALLOW_MEMORY_GROWTH=0 \
	-s INITIAL_MEMORY=4194304 \
	-s STACK_SIZE=65536 \
	--no-entry

CFLAGS   = $(COMMON)
CXXFLAGS = $(COMMON) -std=c++17

OBJS = scsp_wasm.o scsp.o scspdsp.o scsp_waveforms.o

all: scsp.js

scsp.js: $(OBJS)
	$(CXX) $(COMMON) -o scsp.js $(OBJS)

scsp_wasm.o: scsp_wasm.cpp scsp.h scspdsp.h
	$(CXX) $(CXXFLAGS) -c -o $@ $<

scsp.o: scsp.cpp scsp.h scspdsp.h
	$(CXX) $(CXXFLAGS) -c -o $@ $<

scspdsp.o: scspdsp.cpp scspdsp.h
	$(CXX) $(CXXFLAGS) -c -o $@ $<

scsp_waveforms.o: scsp_waveforms.c scsp_waveforms.h
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f scsp.js scsp.wasm $(OBJS)

.PHONY: all clean
