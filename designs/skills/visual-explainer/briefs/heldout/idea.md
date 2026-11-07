# Traffic jams out of nowhere

- **Idea:** Past a certain number of cars on the road, a driver who eases off a little makes the one behind brake a little more, and so on back, until someone stops. No cause is needed. The jam is a wave that moves backward, against the traffic, at about 20 km/h, while each car drives into its back, waits, and leaves from its front.
- **For:** A curious commuter who has sat in a jam that cleared with nothing to show for it.
- **Question:** Why do traffic jams appear on a highway when there’s no accident, no roadwork, nothing?
- **Facts** (from `simulate-idea.mjs`: a one-lane ring road 3 km long, in the Nagel–Schreckenberg cell model, 7.5 m cells and one-second steps, a top speed of 108 km/h; drivers who ease off by one step at random with a chance of 0.2 a second, seed 20261106; 30 minutes per run):
  - If no driver ever eases off, no car stops, at any number of cars from 10 to 40 a km.
  - With easing off: at 10 cars a km no car stops in 30 minutes; at 15, the first stop comes after 927 seconds, and no jam lasts. At 20 a km, 1.2% of cars are stopped at a time; at 25, 10%; at 30, 21%; at 40, 35%.
  - The jam’s back moves backward at 19.8 to 20.6 km/h at every number of cars where one forms.
  - Cars past a point an hour rise to about 1,920 at 20 to 25 cars a km, then fall: 1,841 at 30 and 1,695 at 40, as jams take over.
  - [Sugiyama and others (2008)](https://iopscience.iop.org/article/10.1088/1367-2630/10/3/033001) saw the same with real cars on a circular track: from even, moving traffic, a jam formed and moved backward like a wave.
- **Shape:** A mechanism over space and time, and a threshold: cars’ paths with the jam as a band drifting the other way, and the number of cars on the road against whether a jam forms.
- **Must show:** cars moving forward while the jam moves backward; a small slowdown growing as it passes back from car to car; that a jam forms only above a certain number of cars a km, and never if no one eases off.
- **Traps:** a single accident or bottleneck drawn as the cause; a step-by-step list of what drivers do; the jam drawn as a fixed place on the road; a bar chart of stopped cars by density, which shows the threshold but not the wave.
